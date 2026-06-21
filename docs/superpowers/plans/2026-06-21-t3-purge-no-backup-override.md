# T3 Purge No-Backup Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Ubuntu operators permanently purge T3 rows without falsely claiming a backup exists, using an explicit permanent-data-loss acknowledgement.

**Architecture:** Extend the existing fixed-predicate purge script with a second destructive acknowledgement. Preserve dry-run behavior, mutation safety, polling, and final zero-row verification; update contract tests and README usage.

**Tech Stack:** Bash, Docker, ClickHouse 26.x, TypeScript, Vitest.

## Global Constraints

- The deletion predicate remains exactly `country_tier = 'T3'`.
- T1, T2, and country-unknown rows are never selected.
- Dry run remains the default.
- Destructive execution requires `APPLY=1` plus `BACKUP_VERIFIED=1` or `ACCEPT_PERMANENT_DATA_LOSS=1`.
- No script query prints passwords.
- Shell scripts use LF line endings and run on Ubuntu.

---

### Task 1: Contract-test the no-backup acknowledgement

**Files:**
- Modify: `__tests__/hard-drop-t3-config.test.ts`
- Modify: `scripts/purge-existing-t3.sh`

**Interfaces:**
- New environment variable: `ACCEPT_PERMANENT_DATA_LOSS`, default `0`
- Existing variables preserved: `APPLY`, `BACKUP_VERIFIED`, `POLL_SECONDS`, `TIMEOUT_SECONDS`

- [ ] **Step 1: Write the failing contract assertions**

Add assertions that the script declares the new variable and accepts either acknowledgement:

```ts
expect(script).toContain('ACCEPT_PERMANENT_DATA_LOSS="${ACCEPT_PERMANENT_DATA_LOSS:-0}"')
expect(script).toContain('BACKUP_VERIFIED" != "1" && "$ACCEPT_PERMANENT_DATA_LOSS" != "1"')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- __tests__/hard-drop-t3-config.test.ts`

Expected: FAIL because the no-backup variable and OR gate are absent.

- [ ] **Step 3: Implement the minimal acknowledgement gate**

Declare:

```bash
ACCEPT_PERMANENT_DATA_LOSS="${ACCEPT_PERMANENT_DATA_LOSS:-0}"
```

Replace the existing backup-only check with:

```bash
if [[ "$BACKUP_VERIFIED" != "1" && "$ACCEPT_PERMANENT_DATA_LOSS" != "1" ]]; then
  echo "ERROR: refusing permanent deletion without an explicit acknowledgement." >&2
  echo "Use BACKUP_VERIFIED=1 after backup verification, or ACCEPT_PERMANENT_DATA_LOSS=1 to proceed without recovery." >&2
  exit 1
fi

if [[ "$BACKUP_VERIFIED" != "1" ]]; then
  echo "WARNING: no verified backup; permanent T3 data loss explicitly accepted." >&2
fi
```

Update the script header and dry-run instructions to show both commands.

- [ ] **Step 4: Run focused tests and Bash syntax verification**

Run:

```bash
npm test -- __tests__/hard-drop-t3-config.test.ts
bash -n scripts/purge-existing-t3.sh
```

Expected: all focused tests pass and Bash exits 0.

- [ ] **Step 5: Commit**

```bash
git add __tests__/hard-drop-t3-config.test.ts scripts/purge-existing-t3.sh
git commit -m "feat(ops): allow explicit no-backup T3 purge"
```

### Task 2: Document Ubuntu commands

**Files:**
- Modify: `README.md`
- Modify: `__tests__/hard-drop-t3-config.test.ts`

**Interfaces:**
- Dry run: `./scripts/purge-existing-t3.sh`
- Backed-up purge: `BACKUP_VERIFIED=1 APPLY=1 ./scripts/purge-existing-t3.sh`
- No-backup purge: `ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 ./scripts/purge-existing-t3.sh`

- [ ] **Step 1: Write a failing README contract test**

```ts
test('README documents Ubuntu no-backup purge usage', () => {
  const readme = readFileSync('README.md', 'utf8')
  expect(readme).toContain('ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- __tests__/hard-drop-t3-config.test.ts`

Expected: FAIL because README lacks the no-backup command.

- [ ] **Step 3: Update the README runbook**

Document all three commands and state that the no-backup command is irreversible.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- __tests__/hard-drop-t3-config.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md __tests__/hard-drop-t3-config.test.ts
git commit -m "docs: add Ubuntu no-backup T3 purge command"
```

### Task 3: Runtime and full verification

**Files:**
- No production file changes expected

- [ ] **Step 1: Verify dry run on the local zero-T3 table**

Run: `bash scripts/purge-existing-t3.sh`

Expected: reports `t3_rows: 0`, submits no mutation, and exits 0.

- [ ] **Step 2: Verify the unacknowledged destructive gate**

Record the credentials-table mutation count, run `APPLY=1 bash scripts/purge-existing-t3.sh`, and record the count again.

Expected: exits nonzero and mutation count is unchanged.

- [ ] **Step 3: Verify the no-backup path**

Run: `ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh`.

Expected: prints the no-backup warning, mutation completes without failure, and reports `remaining_t3=0`.

- [ ] **Step 4: Run full verification**

Run sequentially:

```bash
npm test
npm run lint
npm run typecheck
npm run build
git diff --check origin/main...HEAD
```

Expected: all tests pass; lint, typecheck, build, and diff check exit 0.

### Task 4: Push, merge, and deploy

**Files:**
- Review all branch changes

- [ ] **Step 1: Push and create a PR**

Push `feat/t3-purge-no-backup-override` and open a PR against `main` containing test evidence and runtime results.

- [ ] **Step 2: Merge and update local main**

Merge after verification, then fast-forward the original checkout to `origin/main`.

- [ ] **Step 3: Verify Ubuntu delivery state**

Confirm the merged script has LF line endings, executable Bash syntax, and the README command is available after `git pull`.
