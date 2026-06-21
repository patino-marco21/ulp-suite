# Low-Memory T3 Purge Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover from failed heavyweight T3 mutations and purge large T3 datasets with bounded memory using synchronous lightweight deletion.

**Architecture:** Extend the existing fixed-predicate Bash script to cancel only an exact failed T3 mutation, refuse unrelated active mutations, and run `DELETE FROM` with bounded threads and synchronous replica completion. Preserve acknowledgements and verify zero remaining T3 rows while allowing background merges to reclaim disk gradually.

**Tech Stack:** Bash, Docker, ClickHouse 26.3, TypeScript, Vitest.

## Global Constraints

- Predicate remains exactly `country_tier = 'T3'`.
- Never cancel an unrelated mutation.
- Use lightweight `DELETE FROM`, not heavyweight `ALTER TABLE ... DELETE`.
- Use `lightweight_deletes_sync = 2`, `max_threads = 2`, and `max_execution_time = 0`.
- Do not run `OPTIMIZE FINAL`.
- Preserve dry-run and acknowledgement behavior.
- Shell script remains LF-normalized and Ubuntu-compatible.

---

### Task 1: Contract the low-memory SQL and recovery guard

**Files:**
- Modify: `__tests__/hard-drop-t3-config.test.ts`
- Modify: `scripts/purge-existing-t3.sh`

**Interfaces:**
- Produces helper `cancel_failed_t3_mutations`
- Destructive SQL becomes synchronous lightweight `DELETE FROM`

- [ ] **Step 1: Write failing contract assertions**

Assert that the script contains:

```ts
expect(script).toContain('DELETE FROM ulp.credentials')
expect(script).not.toContain('ALTER TABLE ulp.credentials\nDELETE WHERE')
expect(script).toContain('lightweight_deletes_sync = 2')
expect(script).toContain('max_threads = 2')
expect(script).toContain('max_execution_time = 0')
expect(script).toContain('KILL MUTATION')
expect(script).toContain("command = '(DELETE WHERE country_tier = \\\'T3\\\')'")
expect(script).not.toContain('OPTIMIZE TABLE')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- __tests__/hard-drop-t3-config.test.ts`

Expected: FAIL because the script still uses heavyweight deletion and has no cancellation path.

- [ ] **Step 3: Implement exact failed-mutation cancellation**

Add `cancel_failed_t3_mutations` that lists unfinished exact T3 mutations with nonempty `latest_fail_reason` and synchronously kills each by `mutation_id`. Keep the SQL constraints on database, table, failed state, and exact command in both lookup and kill operations.

- [ ] **Step 4: Replace heavyweight deletion**

After cancellation and the unrelated-active-mutation check, execute:

```sql
DELETE FROM ulp.credentials
WHERE country_tier = 'T3'
SETTINGS lightweight_deletes_sync = 2,
         max_threads = 2,
         max_execution_time = 0
```

Remove asynchronous mutation-id lookup/polling because `lightweight_deletes_sync=2` blocks until completion on all replicas. Retain final `remaining_t3` verification.

- [ ] **Step 5: Report physical storage semantics**

Capture active-part bytes before and after. Print that visible rows are gone immediately but physical disk is reclaimed by normal merges and may not decrease during the command.

- [ ] **Step 6: Run focused tests and Bash syntax verification**

Run:

```bash
npm test -- __tests__/hard-drop-t3-config.test.ts
bash -n scripts/purge-existing-t3.sh
git diff --check
```

Expected: focused tests pass, Bash exits 0, and diff check is clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/purge-existing-t3.sh __tests__/hard-drop-t3-config.test.ts
git commit -m "fix(ops): use bounded-memory lightweight T3 deletion"
```

### Task 2: Update operator documentation

**Files:**
- Modify: `README.md`
- Modify: `__tests__/hard-drop-t3-config.test.ts`

- [ ] **Step 1: Write a failing documentation contract**

Assert README states that failed exact T3 mutations are recovered automatically and physical space returns through background merges.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- __tests__/hard-drop-t3-config.test.ts`

- [ ] **Step 3: Update README**

Document rerunning the same no-backup Ubuntu command after `git pull`, automatic exact-failure cancellation, bounded-memory lightweight deletion, and gradual disk reclamation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- __tests__/hard-drop-t3-config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add README.md __tests__/hard-drop-t3-config.test.ts
git commit -m "docs: explain low-memory T3 purge recovery"
```

### Task 3: Runtime and full verification

**Files:**
- No additional production changes expected

- [ ] **Step 1: Verify dry run**

Run `bash scripts/purge-existing-t3.sh` against the local zero-T3 table.

Expected: reports zero T3 and submits no delete.

- [ ] **Step 2: Verify acknowledged lightweight path**

Run:

```bash
ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh
```

Expected: lightweight delete completes synchronously, reports zero remaining T3, and prints gradual-reclamation guidance.

- [ ] **Step 3: Verify mutation health**

Query `system.mutations` and confirm no unfinished/failed mutation was introduced on the local credentials table.

- [ ] **Step 4: Run full verification sequentially**

```bash
npm test
npm run lint
npm run typecheck
npm run build
git diff --check origin/main...HEAD
```

Expected: all commands exit 0. If the known parallel SQLite test collision appears, verify that file independently and rerun the full suite.

### Task 4: Push, merge, and Ubuntu handoff

**Files:**
- Review all branch changes

- [ ] **Step 1: Push and open a PR**

Push `fix/low-memory-t3-purge`, include the 414M-row failure diagnosis and verification evidence, and open a PR against `main`.

- [ ] **Step 2: Merge and update local main**

Merge after verification and fast-forward the original checkout.

- [ ] **Step 3: Provide corrected Ubuntu command**

```bash
cd ~/ulp-suite
git pull
ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh
```

The script must automatically cancel mutation `0000000003` only if it still matches the exact failed T3 command, then perform the low-memory delete.
