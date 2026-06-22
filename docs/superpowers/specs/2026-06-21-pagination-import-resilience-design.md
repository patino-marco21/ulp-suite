# Pagination and Import Resilience Design

## Objective

Make the Credentials Browser open and reset to 200 globally domain-alphabetized rows, reduce page-turn work, and prevent temporary ClickHouse outages from cutting off large inbox imports or cascading every queued file into `inbox/failed`.

## Confirmed Requirements

- The Credentials Browser defaults to 200 rows per page.
- Results default to global `Domain A→Z` ordering, with empty domains last.
- Clear/reset restores the same 200-row and `domain_asc` defaults.
- Existing sort and page-size controls remain available.
- Large text, CSV, and ZIP-entry imports use bounded client-side batches.
- Temporary ClickHouse network outages pause and retry the current operation instead of immediately failing the file.
- Non-transient ClickHouse errors still fail promptly and visibly.
- Full-table content deduplication does not run concurrently after every imported file.
- Scheduled and explicitly requested content deduplication remain available.

## Root-Cause Findings

### Browser latency

The UI and `/api/credentials` independently hardcode `limit=50` and `sort=imported_desc`. Page turns already use cursor pagination and correctly skip the total-count query after page one, but `imported_desc` is not the prefix order of the credentials table. The table is physically ordered by `(domain, email, imported_at)`, while `domain_asc` follows that layout much more closely. A shared default prevents the UI, reset path, and API from drifting again.

Increasing the page size does not make a single query intrinsically faster; it reduces page turns by returning four times as many rows. Changing the default to `domain_asc` is the query-shape improvement.

### Large-file cutoff and cascading failures

`ECONNREFUSED 172.18.0.2:8123` means the app reached the Docker network address but no ClickHouse HTTP listener was available. The current import path performs no transient retry. Any failed source check or batch insert throws to the inbox watcher, which moves the claimed file to `failed/`; the serial queue then starts the next file immediately, so one ClickHouse restart can fail the entire backlog.

The pipeline currently creates 500,000-row batches, enables server-side asynchronous insertion for those already-large client batches, and permits four insert threads. ClickHouse's current guidance recommends synchronous insertion when the client already batches data and identifies 10,000–100,000 rows as the ideal batch range. The application also starts an exact full-table content-dedup statistics query after each completed file. Because that hook is fire-and-forget, it can overlap the next import and compete for ClickHouse memory, CPU, and merge capacity.

## Design

### Shared browse defaults

Create `lib/credential-browse-defaults.ts` containing:

```ts
export const DEFAULT_CREDENTIAL_LIMIT = 200
export const DEFAULT_CREDENTIAL_SORT = 'domain_asc' as const
```

Both `app/credentials/page.tsx` and `app/api/credentials/route.ts` consume these constants. Initial state, first load, Clear All, and the column-sort reset state all use them. The API continues to enforce a maximum of 200, and explicit caller parameters continue to override defaults.

The existing `SORT_MAP.domain_asc` remains authoritative: non-empty domains sort ascending, followed by email, import time, URL, and password; empty domains remain last. Cursor pagination continues unchanged.

### Bounded synchronous ingestion

Change `processTextStream` to request 100,000-row parser batches. `insertBatch` will use a normal synchronous ClickHouse insert, preserve `insert_deduplicate` and the deterministic `insert_deduplication_token`, remove asynchronous-insert settings, and set `max_insert_threads=2`.

Every retry recreates the CSV stream from the unchanged credential array. Batch contents, order, breach name, and deduplication token therefore remain identical, which is required for safe retry behavior.

### Transient ClickHouse retry boundary

Add a focused `lib/clickhouse-retry.ts` module with:

- `isTransientClickHouseError(error): boolean`, matching connection refusal/reset, socket closure, DNS/transient network failures, and HTTP 502/503/504 responses.
- `withClickHouseRetry(operation, options?): Promise<T>`, using exponential backoff from 1 second to a 30-second cap and a 30-minute deadline.
- An injectable sleep function and clock for deterministic tests.
- An optional retry callback for structured progress logging.

Apply the wrapper to:

- the initial `ulp.sources` already-imported check;
- each synchronous credential batch insert;
- the final source-record check and insert.

ClickHouse semantic errors such as malformed data, authorization failure, invalid SQL, too many parts, or explicit memory-limit errors are not classified as transient and fail immediately. If the 30-minute availability deadline expires, the file moves to `failed/` with a message that includes the attempt count and last connection error. Because the active queue item waits during a temporary outage, later files remain queued instead of cascading into failure.

The inbox status continues to show the current file as processing. Retry attempts are logged with the filename/batch context and next delay; no credentials or passwords are logged.

### Remove import-time full-table dedup contention

Remove the `runContentDedupTick({ trigger: 'import' })` call from `processTextStream`. This does not remove deduplication support:

- deterministic insert tokens still protect identical retried batches;
- the scheduled dedup cron remains controlled by `DEDUP_CRON_HOURS`;
- the admin/manual dedup path remains available;
- the existing browser `Unique` view remains unchanged.

This prevents each multi-gigabyte file from launching a whole-table exact-cardinality scan while the next file begins inserting.

## Error Handling and Data Safety

- Only recognized transport/temporary gateway errors retry.
- Retries reuse byte-equivalent row order and the same deterministic token.
- A file is marked complete only after all batches and `ulp.sources` recording succeed.
- A process crash still leaves the file in `processing/`; the existing startup sweep moves it to `failed/` and warns that it may be partial.
- Persistent outages eventually fail one active file after 30 minutes rather than rapidly failing every queued file.
- No automatic re-read from byte zero is introduced, because replay beyond ClickHouse's deduplication window could duplicate already-committed batches.

## Testing

- Contract tests assert the shared defaults are 200 and `domain_asc` and are used by both UI and API paths.
- Cursor tests continue proving empty domains are last and domain cursors are stable.
- Retry unit tests cover transient classification, immediate non-transient failure, exponential delay capping, eventual success, and deadline exhaustion.
- Insert tests assert synchronous mode, `max_insert_threads=2`, stable deduplication tokens across retries, and CSV stream recreation.
- Stream tests assert 100,000-row batching and absence of the post-import content-dedup hook.
- Existing ZIP, inbox, parser, dedup, build, lint, and typecheck suites remain green.
- Runtime verification imports a generated file larger than one batch, confirms multiple completed inserts and one source record, and checks that no failed inbox record is created.

## Deployment and Operations

Deployment requires rebuilding the app container after pulling because the changes are in Next.js and the ingestion worker:

```bash
cd ~/ulp-suite
git pull
docker compose up -d --build app
```

Existing files in `inbox/failed` are not retried automatically. After ClickHouse is healthy and the updated app is running, the operator can use the Inbox Monitor's retry action. Files that were partially imported remain protected by deterministic batch tokens only within ClickHouse's configured deduplication window; operators should retry promptly and verify source counts.

## Out of Scope

- Persistent byte-offset checkpoints and arbitrary process-crash resume.
- Changing the credentials table primary key or materializing a new projection.
- Removing the browser's other sort modes.
- Automatically retrying semantic ClickHouse failures.
- Automatically moving all existing failed files back into the inbox during deployment.
