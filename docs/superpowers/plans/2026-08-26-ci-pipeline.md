# CI Pipeline (GitHub Actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that runs `typecheck`, `test`, and `lint` on every push to `main` and every pull request targeting `main`, and confirm it actually triggers and passes on the real repo.

**Architecture:** One new file, `.github/workflows/ci.yml`. Single job, three sequential steps, no service containers. No application code changes.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`), Node 24, npm.

## Global Constraints

- Platform: GitHub Actions only — `origin` is `https://github.com/patino-marco21/ulp-suite.git`.
- Enforcement: report-only. Do NOT configure branch protection or required status checks — out of scope for this plan.
- Trigger: `push` to `main` and `pull_request` targeting `main` only — not every branch.
- Node version: `24` (matches `Dockerfile`'s `node:24-bookworm-slim`, no version matrix).
- Install command: `npm ci`, not `npm install` (reproducible from `package-lock.json`).
- `SQLITE_PATH` must be set to an ephemeral path in the workflow's `env` — without it, a fresh checkout's vitest workers race to seed the first admin user (~1-in-2 to 1-in-3 flake rate, per `docs/superpowers/specs/2026-08-26-ci-pipeline-design.md`). This is workflow config only — do not touch `lib/sqlite.ts`'s own default.
- Verification for this plan means a real GitHub Actions run passing on `main` — there is no local dry-run for Actions syntax/triggers. Direct push to `main` is the verification step (this repo's history is direct-to-main commits, not PR-merge; the user has standing permission to push to main once changes are verified).

---

### Task 1: Add and verify the CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: existing `package.json` scripts `typecheck`, `test`, `lint` (all already exist and pass locally — confirmed 2026-08-26: `tsc --noEmit` clean, 73/73 test files / 1106/1106 tests passing).
- Produces: nothing consumed by other tasks — this plan has only one task.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/ci.yml` with exactly this content:

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

- [ ] **Step 2: Validate YAML syntax locally**

Run:

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('valid yaml')"
```

Expected output: `valid yaml`

This only catches malformed YAML (bad indentation, stray characters) — it does not validate GitHub Actions' own schema (job/step keys, action names). That's what Step 5's real run confirms.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: add GitHub Actions workflow for typecheck/test/lint

Report-only — no branch protection, no service containers. Closes the
"73 test files, zero CI" audit finding. See
docs/superpowers/specs/2026-08-26-ci-pipeline-design.md for the design
and docs/superpowers/plans/2026-08-26-ci-pipeline.md for this plan.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push to main**

```bash
git push origin main
```

- [ ] **Step 5: Watch the run and confirm it passes**

```bash
gh run list --branch main --limit 1
```

Wait for a run to appear against the commit just pushed (may take a few
seconds to register), then:

```bash
gh run watch --exit-status
```

Expected: the command exits 0 once the run completes, and `gh run list`
shows `completed` / `success` for the `CI` workflow.

If it fails instead, run `gh run view --log-failed` to see which step
failed, fix the underlying issue (not the workflow's structure — the
three scripts already pass locally, so a CI-only failure most likely
means an environment difference, e.g. a case-sensitive filesystem issue
or a missing env var), and repeat from Step 3 with a new commit.

- [ ] **Step 6: Confirm the badge-worthy state**

```bash
gh run list --workflow=ci.yml --limit 3
```

Expected: the most recent run shows `success`. This is the deliverable —
a green check now exists for real, not just a workflow file that's never
been exercised.

---

## Implementation Note (real issue hit during execution)

The first two pushes both failed instantly (0s, zero jobs/check-runs
created — confirmed via `gh api .../check-suites` down to the specific
`github-actions` check-suite, which showed `total_count: 0` check-runs).
Root cause: `env: SQLITE_PATH: ${{ runner.temp }}/ci-test.db` at the
job level — the `runner` context is only available at the *step* level in
GitHub Actions, not in `jobs.<job_id>.env` expressions. This produces an
"Unrecognized named-value: runner" validation error that rejects the whole
workflow file before any job is ever scheduled, which is why it never
showed up as a normal step failure. Confirmed against
[actions/runner#2204](https://github.com/actions/runner/issues/2204).
Fixed by using a fixed path (`/tmp/ci-test.db`) instead — no cross-run
collision risk since every GitHub-hosted job runs on a fresh VM.

Also discovered while diagnosing: this repo has five unrelated third-party
GitHub App check-suites registered on every commit (`docker`, `cursor`,
`vercel`, `railway-app`, `supabase`), all permanently stuck at `status:
queued`. No local config files (`vercel.json`, `railway.toml`, etc.) or
webhooks reference them — most likely account-wide app installations from
other projects, not anything specific to this repo. Flagged to the user;
not investigated further as it's outside this plan's scope.

## Self-Review Notes

- **Spec coverage:** platform (GH Actions) ✓, enforcement (report-only, no branch protection added) ✓, single job/three steps ✓, no Node matrix ✓, main-only trigger ✓, `SQLITE_PATH` workaround ✓, `npm ci` ✓. All spec decisions are reflected in Step 1's YAML.
- **Placeholder scan:** none — the workflow YAML, commit message, and every command are complete and copy-pasteable.
- **Type/name consistency:** N/A (single task, no cross-task interfaces beyond "nothing").
