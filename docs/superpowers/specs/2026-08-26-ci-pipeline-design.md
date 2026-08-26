# CI Pipeline (GitHub Actions) Design

**Date:** 2026-08-26
**Status:** Approved

## Goal

Run the existing `typecheck`, `test`, and `lint` scripts automatically on every push to `main` and every pull request targeting `main`, so a regression shows up as a visible status check instead of only surfacing when someone remembers to run the scripts locally.

## Problem Statement

The repo has 73 test files (1,106 tests, ~17s wall clock), a working `tsc --noEmit` typecheck, and a working `next lint` — all wired up in `package.json` — but nothing runs any of them automatically. There is no `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, or equivalent anywhere in the repository (confirmed via direct search). Verification is currently 100% manual.

Surfaced during a 2026-08-26 scalability/structure audit (`docs/superpowers/specs/` sibling context: see the published audit referenced in project memory) as one of seven findings, scoped to be fixed independently of the others.

## Scope Decisions

- **Platform:** GitHub Actions. The repo's `origin` remote is `https://github.com/patino-marco21/ulp-suite.git` — no new platform/account needed, and no other CI system is in use anywhere in the repo.
- **Enforcement:** Report-only. The workflow adds a visible ✓/✗ status to every push and PR. It does **not** configure branch protection or require the check to pass before merging — that's a separate, more consequential repo-settings change, deliberately out of scope for this pass.
- **Jobs:** One job, three sequential steps (typecheck → test → lint), not three parallel jobs. The full local suite runs in ~17s wall clock; splitting into concurrent jobs would add YAML complexity and consume more runner-minutes for no meaningful speed win at this size.
- **Node version matrix:** None. The app targets exactly Node 24 everywhere (`Dockerfile`'s three `FROM node:24-bookworm-slim` stages, README's `nvm install 24`). No stated multi-version compatibility requirement.
- **Trigger branches:** `main` only (via `push` and `pull_request`), not every branch. The repo already carries several `claude/*` and `worktree-*` branches from prior sessions; running CI on every push to those would be noisy without adding value.

## Architecture

Single new file: `.github/workflows/ci.yml`.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      SQLITE_PATH: /tmp/ci-test.db
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run lint
```

## The SQLITE_PATH Detail

`lib/sqlite.ts`'s `DB_PATH` falls back to `./data/ulp.db` whenever `SQLITE_PATH` is unset. A fresh CI checkout has no pre-existing `./data/ulp.db`, so without this env var, vitest's parallel workers would race to seed the first admin user — a real, previously-reproduced `UNIQUE constraint failed: users.email` flake (~1-in-2 to 1-in-3 runs), not a hypothetical one.

Setting `SQLITE_PATH` to a fixed ephemeral path (`/tmp/ci-test.db`) is scoped as **CI workflow configuration only**. It does not change `lib/sqlite.ts`'s own default, and it is not a fix for the underlying test-isolation gap (a separate, already-identified finding that needs its own design decision — picking a permanent default of `:memory:` vs. a temp file is a real choice, not a one-line change). This workaround only prevents CI itself from being flaky; the application's default behavior is untouched.

**Correction made during implementation:** the original design used `${{ runner.temp }}/ci-test.db`. This fails workflow validation — `runner` context is not available in `jobs.<job_id>.env` expressions ("Unrecognized named-value: runner"; see [actions/runner#2204](https://github.com/actions/runner/issues/2204)), only at the step level. A fixed `/tmp/ci-test.db` avoids the `runner` context entirely and satisfies the same design intent — every GitHub-hosted runner is a fresh VM, so there's no cross-run collision risk from hardcoding the path.

## Testing

Verification is the workflow succeeding on a real push/PR:
1. Push this spec + the workflow file to a branch, open a PR against `main`.
2. Confirm the `CI / verify` check appears on the PR and goes green.
3. Confirm `npm ci` (not `npm install`) is used, so the run is reproducible from `package-lock.json`.

No unit test is meaningful for a CI workflow file itself — the only real test is a live run.

## Implementation Order

1. Create `.github/workflows/ci.yml`.
2. Push and open a PR (or push directly to a branch) to confirm the workflow actually triggers and passes.
3. No changes to any application code, `package.json` scripts, or `lib/sqlite.ts`.

## What This Does NOT Change

- No branch protection / required-status-check configuration.
- No change to `lib/sqlite.ts`'s test-time database default (see the separate, not-yet-scoped test-isolation finding).
- No Docker/ClickHouse service container in CI — confirmed via a full local run that all 73 test files pass with zero live ClickHouse dependency (either pure-logic tests, source-text assertions against route files, or SQLite-backed with the isolation workaround above).
- No deployment step. This workflow only verifies; it does not build or publish the Docker image.
