# Credential Dedup Backfill Design

**Date:** 2026-09-24
**Status:** Approved

## Goal

Collapse `ulp.credentials`' exact-duplicate rows (by the existing `content_key_hash` identity) down to one canonical row per duplicate group, while capturing the cross-source duplication signal — which files/breaches a credential appeared in, and when — as queryable metadata instead of discarding it the way the current view-layer "Unique" filter silently does today.

## Problem Statement

Measured live 2026-09-24: `ulp.credentials` has 2,778,102,283 rows, of which only ~1,380,870,091 are unique by `content_key_hash` (via `uniq()`, the HLL-based approximate-count function — `uniqExact()` was attempted first and hit `MEMORY_LIMIT_EXCEEDED` at 18GB, confirming this table is too large even to *count* duplicates the naive way). **50.29% of the table is exact duplicates.**

Root cause, confirmed via a sampled diagnostic (`GROUP BY content_key_hash` over a ~0.2% hash-sample, cheap enough to run directly): duplication is overwhelmingly cross-source, not repeated imports of the same file. Sampled duplicate groups span up to 70 distinct `source_file` values each (e.g. one group: 242 rows across 70 different files). The source filenames themselves (`DUMP ULP <date> Base34 <N>.txt`, `StarX Cloud - ULP - <date>.txt`, `AMRTECH-TXTLOG-ULP-FREE-<N>.txt`) are classic stealer-log/combo-list redistribution branding — this is the same underlying leaked credential data being repackaged and redistributed under many different names across the combo-list ecosystem, not accidental re-uploads.

This matters for the cleanup approach: per published threat-intel platform architecture guidance, "duplicates should be collapsed but preserve multi-source lineage — knowing three independent sources reported an IP strengthens actionability," and effective handling requires "structural deduplication collapsing entries that reference the same canonical identifier into a single base record that consolidates metadata across sources" rather than a naive purge. The existing "Unique" browse filter already collapses to one arbitrary row per group today — it just throws away the fact that there were N others, so this design is a strict improvement over the status quo on two axes at once (storage *and* a currently-invisible intelligence signal), not just a storage optimization.

## Scope Decisions

Confirmed directly with the user:

- **One-time backfill only.** This collapses what exists today. It does not touch the ingest pipeline — new uploads keep landing as raw duplicates exactly as they do now. Re-running this backfill periodically is a possible future operational choice, not something this design builds.
- **Companion table, not new columns on `ulp.credentials`.** Avoids an `ALTER TABLE` migration across the full 381GB existing table. The companion table can be built, verified, and (if ever wrong) dropped independently, without any schema risk to the main table.
- **Canonical row = earliest `imported_at`** ("first seen"), with a fully deterministic tiebreak (see Architecture) for true ties.
- **Backend only this pass.** No UI changes. Surfacing "seen in N sources" to analysts in the Credentials Browser is a natural follow-up, explicitly out of scope here.

## Architecture

### Companion table

```sql
CREATE TABLE ulp.credential_dedup_meta
(
    content_key_hash    UInt64,
    source_count         UInt32,            -- total duplicate rows, not just distinct files
    sources               Array(String),      -- groupUniqArray(50) — capped so a credential
                                              -- seen in thousands of dumps can't blow memory
    first_seen            DateTime,
    last_seen             DateTime,
    canonical_url         String,
    canonical_email       String,
    canonical_password    String,
    canonical_source_file String
)
ENGINE = MergeTree()
ORDER BY content_key_hash
```

Populated with `argMin(col, (imported_at, url, email, password))` for every `canonical_*` column, computed in the *same* aggregation pass as `source_count`/`sources`/`first_seen`/`last_seen`. The tuple `(imported_at, url, email, password)` gives a total, deterministic ordering — first by import time, then lexicographically — so which exact row is canonical is never ambiguous, including among true ties (same `content_key_hash` and same `imported_at`).

`groupUniqArray`'s memory cost is in the same class as `uniqExact` (both track per-group state), which is exactly what already failed once this session at full table scale — this is not a hypothetical risk, it's already been hit once.

### Computing it at 2.78B rows

1. **Prototype on a ~1% deterministic hash-sample first** (`cityHash64(email, password) % 100 = 0`, the same technique already validated for the `email_domain` projection experiment) — a standalone sample table, never touching `ulp.credentials`. Validates the aggregation query shape and, critically, that the later DELETE-matching logic actually identifies "keep exactly one row per group" correctly, before any of this touches real scale.
2. **Real build**, once the prototype validates, with `max_bytes_before_external_group_by` set so the aggregation spills to disk instead of exhausting memory — the standard ClickHouse mechanism for a `GROUP BY` too large to hold in RAM. If that setting still proves impractical at this table's actual scale (times out, still OOMs), the documented fallback is a two-pass `-State`/`-Merge` combinator approach (per-partition partial aggregate states via `groupUniqArrayState`/`minState`/etc., merged afterward) — more engineering, only pursued if the simpler single-pass approach doesn't hold up in practice.
3. **Integrity check before trusting the result**: `sum(source_count)` across `ulp.credential_dedup_meta` must equal `ulp.credentials`'s total row count at the time of the build. If it doesn't match, something is wrong with the aggregation and nothing proceeds to the delete step.

### The delete step

Matches on **content**, not `(_part, _part_offset)`. `_part_offset` was the right tool for the read-only projection experiment, but this table is under live, continuous ingest, and a background merge between "compute the companion table" and "run the delete" would silently invalidate a captured part offset. Content-based matching (`content_key_hash` plus the four `canonical_*` columns, all captured together in the same aggregation pass) is immune to that timing risk — a merge can rewrite which physical part/offset a row lives at, but it can't change the row's content.

```sql
-- Illustrative shape, refined during planning:
DELETE FROM ulp.credentials
WHERE (content_key_hash, imported_at, url, email, password) NOT IN (
    SELECT content_key_hash, first_seen, canonical_url, canonical_email, canonical_password
    FROM ulp.credential_dedup_meta
)
```

### Safety gating

Mirrors `scripts/purge-existing-t3.sh`'s established pattern exactly, not a new invention:

- Dry-run by default.
- Requires explicit `APPLY=1` plus `ACCEPT_PERMANENT_DATA_LOSS=1` to actually delete anything.
- Previews a sample and the row-count delta before any destructive action.
- Refuses to run while any other credential-table mutation is active (same guard the T3 script already has).

Building this tooling is a distinct step from running it destructively. The plan that follows this spec builds and dry-run-verifies everything through "this would delete N rows, keep M rows" — the actual `APPLY=1` destructive run is a separate, explicit, later confirmation, not something that fires automatically at the end of a build task.

## What This Does NOT Change

- **No ingest pipeline changes** — new uploads are unaffected; this is a backfill of existing data only.
- **No `ulp.credentials` schema change** — the aggregate lives entirely in the new companion table.
- **No UI changes** — the Credentials Browser is untouched this pass.
- **No automatic destructive execution** — the real `APPLY=1` delete requires a separate, explicit go-ahead after the dry-run is reviewed, even once all tooling is built and verified.

## Validated finding (sample-scale, 2026-09-24)

The `(content_key_hash, imported_at, url, email, password)` match tuple is *safe* but not perfectly *complete*: on a ~1% sample, 30,581 of ~14M groups (0.22%) had more than one physical row tying on the full tuple — because `imported_at` is batch-level granularity, not per-row-unique, so two genuinely distinct rows (e.g. from different source files uploaded in the same batch) can share every column the tuple checks. This is not a correctness risk — `url`/`email`/`password` are themselves part of the tying tuple, so any rows that tie are guaranteed to share identical content, meaning the companion table's canonical values are always valid and never "frankenstein" combinations from mismatched ties. It just means a small number of true duplicate-tuple rows survive together instead of collapsing to exactly one. Adding `source_file` to the tuple was tested and barely helps (+377 of the gap on the sample) — the ties are inherent to shared `imported_at`, not a missing column. Accepted as a known, harmless limitation rather than engineering a perfect tiebreak (e.g. `_part_offset`, which was already rejected for the staleness risk under live ingest).

## Testing

- Sample-scale prototype (Architecture step 1) is the primary correctness check: verify by hand that a handful of known-duplicated sample rows collapse to the expected single canonical row with the expected `source_count`/`sources` array.
- Integrity check (Architecture step 3) is the primary scale-correctness check at full size.
- Dry-run output (row counts, a sample of what would be deleted) is the final check before anything irreversible.
