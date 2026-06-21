# Low-memory T3 purge recovery

- **Date:** 2026-06-21
- **Status:** Approved (design)
- **Scope:** Repair `scripts/purge-existing-t3.sh` for large ClickHouse tables that exceed memory during heavyweight mutations.

## Problem

On the Ubuntu processing laptop, the script attempted to delete 68,086,393 T3 rows from a 413,922,934-row table using:

```sql
ALTER TABLE ulp.credentials DELETE WHERE country_tier = 'T3'
```

ClickHouse mutation `0000000003` tried to rewrite 14 parts and failed with `MEMORY_LIMIT_EXCEEDED`: projected usage 14.17 GiB against a 14.05 GiB query limit. The server configuration permits a background pool of 20 with a merge/mutation concurrency ratio of 3, so a heavyweight full-table mutation can run many memory-intensive part rewrites concurrently.

The failed mutation remains active in `system.mutations`. The current script consequently refuses a retry because it sees an active mutation.

## Design

### Exact failed-mutation recovery

Before starting destructive work, inspect `system.mutations` for unfinished mutations on `ulp.credentials`.

The script may automatically cancel a mutation only when all conditions hold:

- `database = 'ulp'`
- `table = 'credentials'`
- `is_done = 0`
- `latest_fail_reason != ''`
- `command = '(DELETE WHERE country_tier = \'T3\')'`

Cancellation uses synchronous `KILL MUTATION`. Any other unfinished mutation remains a hard blocker and causes a nonzero exit. This prevents the purge script from interfering with unrelated schema, repair, or dedup work.

### Bounded-memory deletion

Replace heavyweight `ALTER TABLE ... DELETE` with ClickHouse lightweight deletion:

```sql
DELETE FROM ulp.credentials
WHERE country_tier = 'T3'
SETTINGS lightweight_deletes_sync = 2,
         max_threads = 2,
         max_execution_time = 0
```

`lightweight_deletes_sync = 2` waits for all replicas. `max_threads = 2` bounds scan parallelism and memory use. `max_execution_time = 0` permits the large scan to finish without the normal query timeout.

Lightweight deletion makes matching rows immediately invisible by writing delete-mask/patch metadata. Their original bytes are removed later by normal background merges; the script must state that disk reclamation is gradual and must not run `OPTIMIZE FINAL`, which could recreate the same resource spike.

### Verification

After `DELETE FROM` returns, the script verifies:

```sql
SELECT countIf(country_tier = 'T3') AS remaining_t3
FROM ulp.credentials
```

Success requires exactly zero. It also reports total active bytes before and after, with an explicit note that physical bytes may not fall until merges complete.

Dry-run and acknowledgement behavior remain unchanged:

```bash
bash scripts/purge-existing-t3.sh
BACKUP_VERIFIED=1 APPLY=1 bash scripts/purge-existing-t3.sh
ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 bash scripts/purge-existing-t3.sh
```

## Tests

Contract tests will prove that the script:

- Uses `DELETE FROM ulp.credentials`, not heavyweight `ALTER TABLE ... DELETE`.
- Sets `lightweight_deletes_sync = 2`, `max_threads = 2`, and `max_execution_time = 0`.
- Contains exact-command guards for failed T3 mutation cancellation.
- Uses synchronous `KILL MUTATION`.
- Refuses unrelated active mutations.
- Retains the fixed T3 predicate, acknowledgements, password-free output, and zero-row verification.
- Documents gradual disk reclamation and does not invoke `OPTIMIZE FINAL`.

Runtime tests on the local zero-T3 table will insert no credentials. They will create a harmless failed-mutation fixture only if this can be done without touching `ulp.credentials`; otherwise cancellation behavior remains contract-tested and the zero-match lightweight delete path is exercised directly.

## References

- [ClickHouse lightweight `DELETE`](https://clickhouse.com/docs/sql-reference/statements/delete)
- [ClickHouse `KILL MUTATION`](https://clickhouse.com/docs/sql-reference/statements/kill)
- [ClickHouse `system.mutations`](https://clickhouse.com/docs/operations/system-tables/mutations)
- [ClickHouse `max_threads`](https://clickhouse.com/docs/operations/settings/settings#max-threads)
