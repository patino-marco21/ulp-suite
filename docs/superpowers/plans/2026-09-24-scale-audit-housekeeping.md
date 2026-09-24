# Scale Audit Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear four small, independent pieces of debt: a stale row-count comment, two live `npm audit` vulnerabilities, a possible `@clickhouse/client` version bump (gated on an empirical regression check), and four orphaned worktree checkouts.

**Architecture:** No shared state between tasks — pure cleanup, no new abstractions, no application behavior changes except whatever `npm audit fix` and the client bump touch internally.

**Tech Stack:** npm, git worktree, bash.

## Global Constraints

- Never trust `npm audit`/`npm ls`/`npm outdated` alone as proof a fix landed on disk — this project has hit `npm audit fix` reporting "0 vulnerabilities" while leaving `node_modules` untouched before. Always verify with `npm ci` + a direct `node_modules/<pkg>/package.json` check.
- Never trust a changelog summary alone for the `@clickhouse/client` bump — verify empirically against the live `ulpsuite_clickhouse` container, the same way the original mid-stream-timeout bug was diagnosed and fixed.
- Only remove a worktree that is confirmed both clean (no uncommitted changes) and merged into `main` (or, for `credentials-dedupe-materialized-key`, confirmed disowned by git's own worktree metadata with its deliverable already verified live in current source).
- Run `npm test`, `npm run typecheck`, and `npm run lint` after any dependency change in this plan, before committing.

---

### Task 1: Fix the stale row-count comment

**Files:**
- Modify: `app/api/credentials/route.ts:46`

**Interfaces:** None — this is a comment-only change, nothing consumes or produces an interface.

- [ ] **Step 1: Update the comment**

In `app/api/credentials/route.ts`, change line 46 from:

```ts
// Confirmed live against ulp.credentials (91M rows): with dedupe=1, any sort
```

to:

```ts
// Confirmed live against ulp.credentials (2.4B+ rows, measured 2026-08-23/26 —
// see docs/superpowers/specs/2026-09-24-scale-audit-followups-design.md):
// with dedupe=1, any sort
```

- [ ] **Step 2: Confirm nothing else on the line changed**

Run: `git diff app/api/credentials/route.ts`
Expected: only lines 46–47 changed (the comment text), no code lines touched.

- [ ] **Step 3: Commit**

```bash
git add app/api/credentials/route.ts
git commit -m "docs(credentials): fix stale 91M-row comment, now 2.4B+"
```

---

### Task 2: Apply and verify the `npm audit` fixes

**Files:**
- Modify: `package.json`, `package-lock.json` (both via `npm audit fix`, not hand-edited)

**Interfaces:** None — dependency-only change.

- [ ] **Step 1: Record current vulnerable versions before fixing**

```bash
npm audit --json > /tmp/audit-before.json
grep -A2 '"@vitest/mocker"' /tmp/audit-before.json | head -5
cat node_modules/@vitest/mocker/package.json | grep '"version"'
cat node_modules/browserslist/package.json | grep '"version"'
```

Note the printed versions — you'll compare against these after the fix.

- [ ] **Step 2: Run npm audit fix**

```bash
npm audit fix
```

- [ ] **Step 3: Verify the fix actually landed on disk — do NOT trust this output alone**

```bash
npm audit
```

Expected: fewer or zero vulnerabilities reported. **This step alone is not sufficient proof** — continue to Step 4 regardless of what this prints.

- [ ] **Step 4: Force a clean reinstall and verify on-disk versions changed**

```bash
npm ci
cat node_modules/@vitest/mocker/package.json | grep '"version"'
cat node_modules/browserslist/package.json | grep '"version"'
```

Expected: both versions differ from what Step 1 recorded, and match what `package-lock.json` now specifies (`grep -A2 '"@vitest/mocker"' package-lock.json`). If they're unchanged, the fix did not really apply — stop and investigate before proceeding (do not commit).

- [ ] **Step 5: Re-run the full verification suite**

```bash
npm run typecheck
npm test
npm run lint
```

Expected: all three clean, same as before this change (this is a dev-dependency-only fix; no application behavior should differ).

- [ ] **Step 6: Confirm zero vulnerabilities remain for these two advisories**

```bash
npm audit --json | grep -c "GHSA-82fw-gwwq-j7x9\|baseline-browser-mapping"
```

Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): fix @vitest/mocker path-traversal and browserslist DoS advisories

Verified with npm ci + direct node_modules version check, not just
npm audit's own report — this project has seen npm audit fix report
success while leaving node_modules untouched before."
```

---

### Task 3: `@clickhouse/client` version bump, gated on empirical verification

**Files:**
- Modify: `package.json`, `package-lock.json`

**Interfaces:** None — dependency-only change, contingent on Step 3 passing.

**Context:** installed is `1.19.0`; latest is `1.23.1`. `1.19.0` is the exact version the `http_wait_end_of_query = 1` mid-stream-timeout fix (see `docs/superpowers/specs/` and project memory `project_clickhouse_mid_stream_timeout_json_bug`) was diagnosed and verified against. The changelog between these versions includes a v1.21.0 change where "the client now checks the `X-ClickHouse-Exception-Code` response header to detect server errors even when the HTTP status code indicates success" — plausibly relevant to this exact bug class, but not verifiable from the changelog text alone, since the original bug's root cause was specifically that ClickHouse can't change headers *already sent* before a mid-stream failure occurs. This must be checked empirically, not assumed either way.

- [ ] **Step 1: Bump the dependency**

```bash
npm install @clickhouse/client@1.23.1
```

- [ ] **Step 2: Reproduce a forced mid-stream timeout against the live container**

This mirrors the exact technique already proven for this bug (see project memory): force a short `max_execution_time` on a query that starts streaming before it can complete, against the real `ulpsuite_clickhouse` container, and confirm the client surfaces a clean `ClickHouseError` rather than a raw `SyntaxError` from `JSON.parse`.

```bash
node -e "
const { createClient } = require('@clickhouse/client');
const client = createClient({ url: 'http://localhost:8123', username: 'default' });
(async () => {
  try {
    const rs = await client.query({
      query: \"SELECT sleepEachRow(0.1), number FROM system.numbers LIMIT 100\",
      format: 'JSONEachRow',
      clickhouse_settings: {
        max_execution_time: '1',
        timeout_overflow_mode: 'throw',
        http_wait_end_of_query: '1',
      },
    });
    await rs.json();
    console.log('NO ERROR THROWN — unexpected, investigate');
  } catch (err) {
    console.log('Error type:', err.constructor.name);
    console.log('Error message:', err.message);
    console.log('Has ClickHouse error code:', 'code' in err ? err.code : 'no code property');
  }
})();
"
```

Expected: `Error type: ClickHouseError` (or the client's equivalent typed error class), with a real `.code`/`.type` — **not** `Error type: SyntaxError`. Adjust the sleep/limit/timeout numbers if needed until the query genuinely starts streaming before the timeout fires (the same tuning problem noted in project memory — a too-fast query completes before timing out, a too-slow one may not flush a first block).

- [ ] **Step 3: Decide based on Step 2's actual result**

- If Step 2 produced a clean `ClickHouseError`: keep the bump, continue to Step 4.
- If Step 2 produced a raw `SyntaxError` (the original bug reappeared) or any other unexpected crash: revert with `npm install @clickhouse/client@1.19.0`, and skip to Step 6 to commit a no-op with the reason documented instead.

- [ ] **Step 4 (only if keeping the bump): Re-run the full verification suite**

```bash
npm run typecheck
npm test
npm run lint
```

Expected: all three clean.

- [ ] **Step 5 (only if keeping the bump): Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): bump @clickhouse/client 1.19.0 -> 1.23.1

Empirically re-verified the http_wait_end_of_query mid-stream-timeout
fix still produces a clean ClickHouseError (not a SyntaxError) against
the live container after this bump — see verification command in
docs/superpowers/plans/2026-09-24-scale-audit-housekeeping.md Task 3."
```

- [ ] **Step 6 (only if reverting): Commit a no-op documenting why**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): hold @clickhouse/client at 1.19.0

Attempted bump to 1.23.1; empirical mid-stream-timeout repro against
the live container [describe exact observed failure here] after the
bump, so reverted. The v1.21.0 changelog entry about
X-ClickHouse-Exception-Code header detection looked relevant but did
not hold up under live verification. Re-attempt only with a fix for
the specific failure observed."
```

---

### Task 4: Remove orphaned worktree checkouts

**Files:** none in the main repo tree — this removes directories under `.claude/worktrees/` and, where applicable, their branches.

**Interfaces:** None.

**Context, confirmed 2026-09-24:**

| Worktree | Git state | Verdict |
|---|---|---|
| `agitated-albattani-f608f2` | branch `claude/agitated-albattani-f608f2`, HEAD `ce491c9`, ancestor of `main`, only untracked `.claude/` marker | safe to remove + delete branch |
| `amazing-bhaskara-580904` | detached HEAD `6b146bc`, ancestor of `main`, clean | safe to remove |
| `serene-solomon-31e8d3` | detached HEAD `8640889`, ancestor of `main`, clean | safe to remove |
| `credentials-dedupe-materialized-key` | `.git` pointer file broken — `git worktree list` and `.git/worktrees/` no longer reference it at all (already disowned by git, not merely stale); its topic's spec/plan/commits (e.g. `1fc50f3 perf(credentials): point view-level dedupe at content_key_hash`) are already on `main`, and `content_key_hash` is live in `docker/clickhouse/init/01-ulp-tables.sql` today | safe to remove (plain directory delete — `git worktree remove` won't work since git no longer tracks it) |

`domain-monitor-saved-matches` (a 5th worktree seen earlier in this session) is already gone — removed by something outside this plan between the audit and now. Nothing to do for it.

- [ ] **Step 1: Re-confirm current state immediately before removing anything**

```bash
git worktree list
ls -la /home/cole/ulp-suite/.claude/worktrees/
```

Expected: matches the table above (3 registered worktrees + 1 orphaned directory). If anything differs from the table — a new worktree appeared, or one of these shows uncommitted changes now — stop and re-investigate that one specifically rather than proceeding on stale information.

- [ ] **Step 2: Remove the three git-registered worktrees**

```bash
git worktree remove /home/cole/ulp-suite/.claude/worktrees/agitated-albattani-f608f2
git worktree remove /home/cole/ulp-suite/.claude/worktrees/amazing-bhaskara-580904
git worktree remove /home/cole/ulp-suite/.claude/worktrees/serene-solomon-31e8d3
```

Expected: each command exits 0 with no output (or a brief confirmation). If any refuses because of uncommitted changes it didn't show in Step 1, stop and re-investigate that one rather than forcing it.

- [ ] **Step 3: Delete the one leftover branch**

```bash
git branch -d claude/agitated-albattani-f608f2
```

Expected: `Deleted branch claude/agitated-albattani-f608f2 (was ce491c9).` (`-d`, not `-D` — this only succeeds because the branch is confirmed merged; if it refuses, that's new information contradicting Step 1's confirmation, so stop and re-investigate rather than switching to `-D`.)

- [ ] **Step 4: Remove the orphaned, git-disowned directory**

```bash
rm -rf /home/cole/ulp-suite/.claude/worktrees/credentials-dedupe-materialized-key
```

- [ ] **Step 5: Verify the directory is clean**

```bash
git worktree list
ls -la /home/cole/ulp-suite/.claude/worktrees/
```

Expected: `git worktree list` shows only the main checkout; `.claude/worktrees/` is empty (or absent).

- [ ] **Step 6: No commit needed**

This task only removes untracked local directories and a fully-merged local branch — nothing here is tracked content in `main`, so there is nothing to commit.
