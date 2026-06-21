# Task 2 Report — Transient ClickHouse Retry Primitive

## Status

Completed with one external concern: repository typecheck currently fails in unrelated existing code under `app/credentials/page.tsx`.

## Commit

- `519dedb139e9cc891fd78e860fec439acb240603` — `feat(import): retry transient ClickHouse outages`

## Files Changed

- `lib/clickhouse-retry.ts`
- `__tests__/clickhouse-retry.test.ts`

## RED Evidence

Command:

```bash
npm test -- __tests__/clickhouse-retry.test.ts
```

Result on first run:

```text
FAIL  __tests__/clickhouse-retry.test.ts [ __tests__/clickhouse-retry.test.ts ]
Error: Cannot find package '@/lib/clickhouse-retry' imported from .../__tests__/clickhouse-retry.test.ts
```

This was the expected RED state because the module did not exist yet.

## GREEN Evidence

After implementing `lib/clickhouse-retry.ts`, the focused retry test suite passed:

```bash
npm test -- __tests__/clickhouse-retry.test.ts
```

Result:

```text
✓ isTransientClickHouseError > classifies connection and gateway failures as transient
✓ isTransientClickHouseError > does not classify semantic ClickHouse failures as transient
✓ withClickHouseRetry > retries transient failures with exponential delays until success
✓ withClickHouseRetry > caps the retry delay at 30000 ms
✓ withClickHouseRetry > throws semantic failures immediately with no sleep
✓ withClickHouseRetry > throws ClickHouseRetryExhaustedError when the next delay would exceed the deadline
Test Files  1 passed (1)
Tests       6 passed (6)
```

## Verification

### Typecheck

Command:

```bash
npm run typecheck
```

Result:

```text
app/credentials/page.tsx(749,16): error TS2345: Argument of type 'string' is not assignable to parameter of type 'SetStateAction<...>'
app/credentials/page.tsx(861,71): error TS2345: Argument of type 'string' is not assignable to parameter of type 'SetStateAction<...>'
```

This failure is outside Task 2 scope and was not modified.

### Full Test Suite

Command:

```bash
npm test
```

Result:

```text
Test Files  26 passed (26)
Tests       626 passed (626)
```

## Self-Review

- `isTransientClickHouseError(error)` checks:
  - transport/error codes,
  - nested `cause.code`,
  - HTTP `status` / `statusCode`,
  - transient transport messages.
- `withClickHouseRetry`:
  - uses injectable `now`, `sleep`, and `onRetry`,
  - applies exponential backoff from 1s up to 30s,
  - refuses to sleep past the elapsed-time deadline,
  - throws `ClickHouseRetryExhaustedError` with `attempts` and `lastError`.
- The module is standalone and does not touch upload processing or any Task 3 behavior.
- Tests cover the required transient classification, capped delay behavior, semantic failure behavior, and deadline exhaustion.

## Concerns

- `npm run typecheck` is currently blocked by two unrelated existing type errors in `app/credentials/page.tsx`.
- No upload-processing code was changed, per Task 2 scope.

## Review-Fix Addendum

The classifier now rejects semantic signals before any transient status/code/message checks, and the retry loop no longer carries a duplicate semantic guard.

### Focused retry test run

Command:

```bash
npm test -- __tests__/clickhouse-retry.test.ts
```

Result after the fix:

```text
✓ isTransientClickHouseError > classifies connection and gateway failures as transient
✓ isTransientClickHouseError > does not classify semantic ClickHouse failures as transient
✓ isTransientClickHouseError > rejects mixed-signal semantic errors even when they look transient
✓ withClickHouseRetry > retries transient failures with exponential delays until success
✓ withClickHouseRetry > caps the retry delay at 30000 ms
✓ withClickHouseRetry > throws semantic failures immediately with no sleep
✓ withClickHouseRetry > throws ClickHouseRetryExhaustedError when the next delay would exceed the deadline
Test Files  1 passed (1)
Tests       7 passed (7)
```

### Typecheck after the fix

Command:

```bash
npm run typecheck
```

Result:

```text
> ulp-suite@1.3.0 typecheck
> tsc --noEmit
```

Exit code: `0`

### Full suite after the fix

Command:

```bash
npm test
```

Result:

```text
Test Files  26 passed (26)
Tests       627 passed (627)
```
