# Raw-stream file uploads (drop multipart/form-data)

- **Date:** 2026-08-16
- **Status:** Approved (design)
- **Scope:** `app/api/upload/route.ts`, `app/api/v1/upload/route.ts`, `app/upload/page.tsx`, `app/docs/page.tsx`. No change to `lib/upload-processor.ts`, `lib/ulp-parser.ts`, or any of the streaming/batching/dedup logic downstream of the request body.

## Problem

Both upload routes call `await request.formData()` before any of the pipeline's per-batch streaming logic runs. `request.formData()` is not incremental — it's Node's built-in Fetch implementation fully consuming the request body and materializing a `File`/`Blob` before it returns anything. Measured directly (session of 2026-08-16, via a standalone script feeding a genuinely lazy `ReadableStream` into `Request.formData()`): a 300 MB body cost ~600 MB in transient `arrayBuffers` growth plus ~304 MB retained in `external`, all before either route's own code executes. `lib/ulp-parser.ts`'s own 4 MB chunk-slicing comment already half-documents this ("`file.stream()` on an in-memory File... can yield the entire file as one Uint8Array").

This directly contradicts the `.zip` handler's own comment in `app/api/upload/route.ts`, which claims "peak RAM ~200 MB regardless of archive size" — true only for the code that runs *after* the file is already fully materialized by `formData()`.

Separately, `app/api/v1/upload/route.ts`'s `.zip` path still does `Buffer.from(await file.arrayBuffer())` — the exact pattern that caused a documented 6 GB OOM crash, already fixed in the non-v1 route by streaming to a temp file instead. Folding that fix in here rather than as a separate change, since it's the same code path.

Full findings and their supporting evidence come from an ingestion-pipeline audit conducted in this session on 2026-08-16 (not filed in the repo — this design doc is the durable record of the two findings it acts on).

## Decisions made during brainstorming

- **Filename travels as a `?filename=` query parameter, not a header.** Simplest for both `fetch()` and `curl --data-binary`; avoids header-encoding edge cases for filenames with special characters.
- **Clean cutover — no dual-path multipart/raw-stream support.** Both routes only accept the new format after this ships. This is a self-hosted, single-org tool with no third-party API consumers to preserve compatibility for; a compatibility shim would be unused complexity.
- **Zip stays disk-buffered, doesn't move to a fully-streaming (no-disk) parser.** Considered avoiding the temp-file write entirely by parsing zip entries as bytes arrive, but ZIP's central directory sits at the end of the archive — a genuinely single-pass parser can't handle the format's full generality without either giving up correctness or buffering the whole archive anyway to fake random access. The existing disk-streaming approach is already proven in production (it's the fix for the 6 GB OOM incident) and keeps peak RAM ~200 MB regardless of archive size. Not worth trading a working, low-risk fix for a speculative, higher-risk one to save one temp-file write that's already cheap relative to the network transfer itself.
- **Content-Type stops being checked entirely.** Once the route isn't parsing multipart, there's nothing about Content-Type to validate — the handler just reads `request.body` as bytes regardless of what the client claims it is.

## Design

**`app/api/upload/route.ts`:**
- Read `filename` from `request.nextUrl.searchParams.get('filename')` — already URL-decoded by `URLSearchParams`, don't decode it again. Missing/empty → 400 `{success: false, error: 'No filename provided'}` (same shape as today's "No file provided", updated wording).
- Mirror the current code's casing split: lowercase the filename only for the `.txt`/`.csv`/`.zip` extension check (`filename.toLowerCase()`), same as today's `file.name.toLowerCase()` — pass the original, un-lowercased filename to `processTextStream`, `matchBreach`, job logging, and the response body, exactly as `file.name` is used today.
- Defensive check: `request.body === null` → 400 `{success: false, error: 'No file data received'}`.
- `.txt`/`.csv`: `processTextStream(request.body, filename, jobId)` in place of `processTextStream(file.stream(), file.name, jobId)`. `contentLength` for the job's `totalLines` estimate still comes from the `Content-Length` header, unaffected by this change.
- `.zip`: `pipeline(Readable.fromWeb(request.body), fs.createWriteStream(tmpPath))` in place of `pipeline(Readable.fromWeb(file.stream() as ...), fs.createWriteStream(tmpPath))` — same temp-file pattern, different stream source.
- Remove: the `formData` try/catch, the `formData.get('file')` lookup, and the `file.name`/`file.stream()`/`file.arrayBuffer()` references throughout.
- Unaffected: rate limiting, admin auth, `Content-Length` size cap, SSE progress (`runWithProgress`), job logging, response JSON shape.

**`app/api/v1/upload/route.ts`:**
- Same `filename` query param, casing convention, and null-body handling as above.
- `.txt`/`.csv`: `processTextStream(request.body, filename)` in place of `processTextStream(file.stream(), file.name)`.
- `.zip`: adopt the non-v1 route's temp-file pattern — `pipeline(Readable.fromWeb(request.body), fs.createWriteStream(tmpPath))` then `processZipFile(tmpPath, ...)` — in place of `Buffer.from(await file.arrayBuffer())` + `processZipBuffer(buffer, ...)`. This removes the `processZipBuffer` call from this route entirely (that function stays in `lib/upload-processor.ts` since it may still be useful elsewhere, but nothing in this design calls it after this change).
- Unaffected: API-key auth, rate-limit headers, `Content-Length` size cap, job logging, response JSON shape.

**`app/upload/page.tsx`:**
- In `processFileSingle`, replace:
  ```ts
  const formData = new FormData()
  formData.append('file', file)
  fetch('/api/upload', { method: 'POST', body: formData })
  ```
  with:
  ```ts
  fetch(`/api/upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
  ```
- No other change. `processFileSingle`'s response handling (jobId/SSE branch vs. sync zip-result branch), `processQueue`, and every rendering branch are keyed off the JSON response shape, which doesn't change.

**`app/docs/page.tsx`** (v1 upload section):
- Example request changes from `curl -X POST ".../api/v1/upload" -H "X-API-Key: ..." -F "file=@stealer_logs.zip"` to `curl -X POST ".../api/v1/upload?filename=stealer_logs.zip" -H "X-API-Key: ..." --data-binary @stealer_logs.zip`.
- "Form Data Parameters" table (currently one row: `file`) becomes a "Query Parameters" table with one row: `filename` (string, required, "Original filename, used to determine .txt/.csv/.zip handling and breach-name matching.").
- Response JSON example is unchanged.

## Testing

No existing test imports either route handler directly — the existing upload tests (`upload-processor.test.ts`, `upload-queue.test.ts`, `upload-skip-imported.test.ts`) cover `lib/upload-processor.ts` functions directly, not the HTTP layer. This session already proved a real `NextRequest` with a body is constructible and testable in this repo's Node-environment Vitest setup (`__tests__/middleware-public-paths.test.ts`).

New test file `__tests__/upload-route-raw-stream.test.ts`, mocking `@/lib/upload-processor`, `@/lib/upload-queue`, `@/lib/auth` / `@/lib/api-key-auth` the way `__tests__/ingest-health-route.test.ts` mocks its dependencies:
- `.txt` upload with `?filename=` set → asserts `processTextStream` is called with the request's body stream and the decoded filename.
- Missing `?filename=` → 400.
- `.zip` upload on `app/api/v1/upload/route.ts` → asserts `processZipFile` is called (not `processZipBuffer`), and that no `Buffer`/`arrayBuffer` path is exercised — the direct regression test for finding #2.
- Unsupported extension → 400, unchanged behavior.

`app/upload/page.tsx`'s one-line fetch-call change gets manual browser verification (drag-drop a real file, confirm it imports and the SSE progress bar still updates) — same boundary as prior UI changes this session: no component-rendering test harness exists in this repo.

## Out of scope

- Findings #3 (content-dedup catch-up query bucketing) and #4 (stale rate-limit comment) — unrelated files, handled as separate, independent follow-ups.
- Any change to `lib/upload-processor.ts`, `lib/ulp-parser.ts`, `lib/upload-queue.ts`, or the ClickHouse insert path — this design only changes how bytes arrive at the existing, already-streaming entry points.
- A compatibility shim for the old multipart format (see Decisions above).
- Any client other than `app/upload/page.tsx` and the documented `curl` example — if other scripts call these endpoints today with multipart, they will need updating separately; not discovered as part of this session.
