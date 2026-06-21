# T3 purge no-backup override

- **Date:** 2026-06-21
- **Status:** Approved (design)
- **Scope:** Ubuntu interface for the existing permanent T3 purge script.

## Problem

`scripts/purge-existing-t3.sh` already performs the required fixed T3 deletion, mutation polling, failure detection, and zero-row verification. Its destructive path currently requires `BACKUP_VERIFIED=1`, which cannot truthfully reproduce the explicitly authorized local purge when no backup exists.

## Design

Keep dry-run behavior unchanged:

```bash
./scripts/purge-existing-t3.sh
```

Permit destructive execution through either of two truthful acknowledgements:

```bash
# A verified off-host backup exists
BACKUP_VERIFIED=1 APPLY=1 ./scripts/purge-existing-t3.sh

# No backup exists; permanent loss is explicitly accepted
ACCEPT_PERMANENT_DATA_LOSS=1 APPLY=1 ./scripts/purge-existing-t3.sh
```

When `APPLY=1`, the script proceeds only if at least one acknowledgement equals `1`. Otherwise it exits nonzero before checking or submitting mutations. The no-backup path prints a prominent warning but uses the same deletion implementation as the backed-up path.

The SQL predicate remains a checked-in constant:

```sql
country_tier = 'T3'
```

No configurable SQL, tier, or suffix is accepted. T1, T2, and country-unknown rows remain outside the deletion predicate.

## Operational behavior

The script continues to:

1. Verify Docker and the ClickHouse container.
2. Report total/T3 counts and a password-free sample.
3. Refuse destructive execution unless `APPLY=1` plus one acknowledgement is present.
4. Refuse to start while another credentials-table mutation is active.
5. Submit asynchronous `ALTER TABLE ... DELETE`.
6. Poll `system.mutations`, failing on `latest_fail_reason` or timeout.
7. Verify `remaining_t3=0` before returning success.

The script remains LF-normalized and directly runnable on Ubuntu.

## Testing

Automated contract tests will verify:

- `ACCEPT_PERMANENT_DATA_LOSS` defaults to `0`.
- The destructive gate accepts either acknowledgement.
- The fixed T3 predicate, mutation monitoring, zero-row verification, and password-free query contract remain present.
- README usage documents dry-run, backed-up, and no-backup commands.

Runtime verification will run the script’s dry run against the local zero-T3 table, verify `APPLY=1` without acknowledgement fails without adding a mutation, and verify the no-backup path safely completes as a zero-match mutation or no-op while retaining zero T3 rows.

## References

- [ClickHouse `ALTER TABLE ... DELETE`](https://clickhouse.com/docs/sql-reference/statements/alter/delete)
- [ClickHouse `system.mutations`](https://clickhouse.com/docs/operations/system-tables/mutations)
