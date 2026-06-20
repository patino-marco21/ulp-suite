# Hard-drop T3 credentials

- **Date:** 2026-06-20
- **Status:** Approved (design)
- **Scope:** Ingest policy, deployment defaults, and permanent removal of existing T3 rows.
- **Origin:** Live audit of `ulp.credentials` (52,329,224 rows) and user confirmation that country-unknown records remain valuable while T3 records must be permanently rejected and removed.

## 1. Problem

The current deployment has two policy gaps:

1. `INGEST_FILTER_DROP_TIERS=T2,T3` is configured locally, which rejects T2 even though the required policy now retains T2.
2. `INGEST_FILTER_KEEP_SUFFIXES` is evaluated before tier drops. A suffix such as `.sa` can therefore rescue a T3 row, contradicting the requirement that T3 be a permanent, non-overridable drop.

The existing table contains this distribution:

| Tier | Rows | Required disposition |
|---|---:|---|
| Unknown (`''`) | 39,544,632 | Keep |
| T3 | 8,176,857 | Permanently delete and reject on future ingest |
| T2 | 3,431,635 | Keep |
| T1 | 1,176,100 | Keep |

Country-unknown rows must not be hidden or deleted. Generic `.com`, webmail, and username-based credentials cannot be assigned reliably to a country from their stored fields.

## 2. Goals and non-goals

### Goals

- Reject every newly parsed credential classified as T3 before ClickHouse insertion.
- Make the T3 rejection non-overridable by keep suffixes.
- Retain T1, T2, and unknown-country credentials.
- Permanently delete every existing `country_tier = 'T3'` row.
- Make deletion dry-run-first, observable, failure-aware, and verified to zero matching rows.
- Preserve the existing independent URL-noise policy.
- Ship repository defaults so an Ubuntu `git pull` plus normal deployment retains the T3 policy.

### Non-goals

- Do not delete or default-hide unknown-country rows.
- Do not delete T2 rows.
- Do not reclassify country tiers in this change.
- Do not infer location from generic `.com` domains or webmail addresses.
- Do not combine malformed-row cleanup with the regional purge. Objective garbage classification remains separate work so regional policy and data-quality policy cannot drift together.

## 3. Policy semantics

Evaluation order at ingest becomes:

1. URL/full-row noise policy, when enabled.
2. Hard tier drop: T3 is rejected immediately.
3. Keep-suffix override for any other configured soft tier/suffix drop.
4. Remaining configured tier and suffix drops.

The implementation will expose T3 as a dedicated hard-drop policy rather than relying solely on the existing soft `INGEST_FILTER_DROP_TIERS` precedence. This makes the invariant testable: no keep suffix can admit a T3 row.

Repository/deployment defaults:

```dotenv
INGEST_FILTER_HARD_DROP_TIERS=T3
INGEST_FILTER_DROP_TIERS=
INGEST_FILTER_KEEP_SUFFIXES=
```

The current local deployment will be changed from `DROP_TIERS=T2,T3` to hard-drop T3 only. Unknown, T1, and T2 records continue through ingest. Saudi Arabia (`.sa`) is currently classified T3 and will therefore be deleted/rejected; UAE (`.ae`) is T2 and retained.

## 4. Components

### Ingest policy

`lib/ingest-filter.ts` will parse `INGEST_FILTER_HARD_DROP_TIERS`, evaluate it before keep overrides, and include it in `policyActive`. The upload processor already invokes `shouldDropAtIngest` before insertion, so no new ingestion path is required.

### Runtime configuration

`docker-compose.yml` will forward the hard-drop variable with a default of `T3`. `.env.example` and operational documentation will describe the distinction between non-overridable hard drops and existing soft drops.

### Existing-data purge

A dedicated script will use the fixed predicate `country_tier = 'T3'`; it will not inherit keep suffixes or soft tier settings. It will:

1. Print total rows, T3 rows, percentage, and a non-secret sample.
2. Exit without mutation unless `APPLY=1`.
3. Submit `ALTER TABLE ulp.credentials DELETE WHERE country_tier = 'T3'` asynchronously.
4. Poll `system.mutations` until completion or failure.
5. Fail on a mutation error or timeout.
6. verify `countIf(country_tier = 'T3') = 0` before reporting success.

The script will never print passwords. It will use LF line endings so it runs both from Ubuntu and from Windows-backed Docker workflows.

ClickHouse documents `ALTER TABLE ... DELETE` as a mutation that rewrites affected data parts, so polling and explicit post-delete verification are required rather than treating successful submission as completion. Lightweight `DELETE FROM` is not selected because this operation is a one-time physical cleanup whose completion must be observable.

## 5. Safety and recovery

- The dry run is mandatory by default.
- The purge predicate is a constant checked into source, not assembled from user-provided SQL.
- A pre-purge count is recorded in output.
- Existing off-host backup guidance remains a prerequisite for production execution; deletion is permanent.
- Concurrent imports are safe because the ingest hard-drop is deployed before the purge starts, preventing new T3 rows from racing into the table.
- Mutation failure details are read from `system.mutations.latest_fail_reason` and produce a nonzero exit.

## 6. Testing and verification

Automated tests will prove:

- T3 is rejected when hard-drop T3 is enabled.
- T3 remains rejected when its suffix is also in the keep list.
- T1, T2, and unknown rows remain accepted under the T3-only policy.
- Existing soft-tier behavior remains unchanged when no hard tier is configured.
- Invalid hard-tier values are ignored.
- `policyActive` recognizes a hard-tier-only policy.
- Compose forwards/defaults the new variable.
- The purge script contains a fixed T3 predicate, dry-run gate, mutation polling, failure handling, and zero-row verification.

Runtime verification will run the focused tests, full test suite, lint, typecheck, production build, Compose rebuild, health checks, ingest-policy smoke test, purge dry run, applied purge, mutation completion check, and final T3 count. The final table distribution must show zero T3 rows while unknown/T1/T2 counts are preserved apart from concurrent legitimate inserts.

## 7. Primary references

- [ClickHouse `ALTER TABLE ... DELETE`](https://clickhouse.com/docs/sql-reference/statements/alter/delete)
- [ClickHouse lightweight `DELETE`](https://clickhouse.com/docs/sql-reference/statements/delete)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [IANA Root Zone Database](https://www.iana.org/domains/root/db)

