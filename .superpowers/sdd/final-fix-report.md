# Final Review Fix Report

## Status

DONE

## Implementation commit

`9647465aaab4d5c562ec403ab5a3d27e5c7c1b56` — `fix(import): close retry and zip failure gaps`

## Files

- `lib/clickhouse-retry.ts`
- `lib/upload-processor.ts`
- `lib/ulp-parser.ts`
- `lib/content-dedup.ts`
- `__tests__/clickhouse-retry.test.ts`
- `__tests__/upload-processor.test.ts`
- `__tests__/insert-batch-dedup.test.ts`
- `__tests__/ulp-parser-stream.test.ts`
- `__tests__/content-dedup.test.ts`

## RED evidence

1. Retry/ZIP regression run:
   `npx vitest run __tests__/clickhouse-retry.test.ts __tests__/upload-processor.test.ts`
   failed as expected with 7 failures and 10 passes. Failures covered production gateway/timeout shapes, semantic precedence, exhaustion summaries, hard deadline abort, source `abort_signal` propagation, and fatal ZIP database errors. Existing corrupt/open-entry continuation tests passed.
2. Parser/content source-contract run:
   `npx vitest run __tests__/ulp-parser-stream.test.ts __tests__/content-dedup.test.ts`
   failed as expected with 2 failures and 28 passes because the stale endpoint and post-import-hook text remained.
3. Credential insert signal run:
   `npx vitest run __tests__/insert-batch-dedup.test.ts`
   failed as expected with 2 failures and 1 pass while `abort_signal` was temporarily absent.

## GREEN evidence

- Focused tests:
  `npx vitest run __tests__/clickhouse-retry.test.ts __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts __tests__/insert-batch-dedup.test.ts __tests__/ulp-parser.test.ts __tests__/ulp-parser-stream.test.ts __tests__/content-dedup.test.ts`
  — 7 files passed, 152 tests passed, 0 failed.
- Typecheck: `npm run typecheck` — passed (`tsc --noEmit`, exit 0).
- Diff validation: `git diff --check` — passed with no whitespace errors.

## Self-review

- ZIP open/decompression/entry-stream failures are explicitly typed at the stream boundary and remain entry-local; database, semantic, and retry-exhaustion failures reject and stop the archive.
- The retry deadline uses one cleaned-up wall-clock timer, aborts the active attempt, and cannot start another attempt after expiry.
- Each ClickHouse query/insert attempt receives its own signal through `abort_signal`; source-record retries use one deadline rather than nested retry loops.
- Exhaustion messages expose only allow-listed connection/status summaries while retaining `attempts` and the original `lastError`.
- Semantic ClickHouse signals are checked before all transient gateway/timeout signals.

## Concerns

None.

---

## Retry Cancellation and Privacy Follow-up

### Status

DONE

### Implementation commit

`3cf58ff69721cd6d0945dcae6b8c852df5ea6595` — `fix(import): harden retry cancellation and privacy`

### Files

- `lib/clickhouse-retry.ts`
- `lib/upload-processor.ts`
- `__tests__/clickhouse-retry.test.ts`
- `__tests__/upload-processor.test.ts`
- `__tests__/insert-batch-dedup.test.ts`

### RED evidence

1. `npx vitest run __tests__/clickhouse-retry.test.ts __tests__/upload-processor.test.ts __tests__/insert-batch-dedup.test.ts` failed with 4 failures and 21 passes: numeric ClickHouse code `516` was retried, arbitrary code leaked in exhaustion status and retry logs, and a post-headers hanging ResultSet was not closed. New ZIP retry-exhaustion tests passed as characterization coverage.
2. `npx vitest run __tests__/upload-processor.test.ts -t "already aborted"` failed with 1 failure: a ResultSet returned after its signal was already aborted was neither closed nor prevented from entering `json()`.
3. `npx vitest run __tests__/clickhouse-retry.test.ts -t "fixed fallback"` failed with 1 failure: arbitrary `Error.name` text was copied into the exhaustion message.

### GREEN evidence

- Focused tests: `npx vitest run __tests__/clickhouse-retry.test.ts __tests__/upload-processor.test.ts __tests__/upload-skip-imported.test.ts __tests__/insert-batch-dedup.test.ts __tests__/ulp-parser.test.ts __tests__/ulp-parser-stream.test.ts __tests__/content-dedup.test.ts` — 7 files passed, 159 tests passed, 0 failed.
- Typecheck: `npm run typecheck` — passed (`tsc --noEmit`, exit 0).
- Diff validation: `git diff --check` — passed.
- Timer/cancellation checks: hanging-body and late-header tests each observed one query attempt and one `ResultSet.close()`; the late-header test observed zero `json()` calls; both observed zero remaining fake timers.
- Privacy checks: arbitrary code, status, and `Error.name` secrets are absent from exhaustion messages; arbitrary code is absent from retry logs; safe `fetch failed` context remains.

### Self-review

- `abort_signal` remains on the source query. Once headers arrive, abort closes the ResultSet body stream; listeners are removed in `finally`, including success, body failure, and abort paths.
- Numeric ClickHouse codes are semantic before gateway-message classification. Named transport codes and HTTP status fields 502/503/504 remain transient.
- One allow-listed summary function now serves both exhaustion messages and upload retry logs.
- Explicit archive regressions cover source retry exhaustion, credential insert retry exhaustion, and corrupt-entry continuation.

### Concerns

None.
