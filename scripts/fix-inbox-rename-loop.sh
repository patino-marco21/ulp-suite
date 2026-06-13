#!/bin/bash
# =============================================================================
# fix-inbox-rename-loop.sh
#
# Investigates the 5 "Completed (0 total)" failures shown in the Inbox
# Monitor UI on 2026-06-13 — each file imported real rows (1.8M / 496K /
# 344K / 10.0M / 339K) and then failed with the SAME error:
#
#   ENOENT: no such file or directory, rename '/app/inbox/<file>' ->
#     '/app/inbox/done/<file>'
#
# One of these files — "VIP ULP 21.04.2026 - @updh1_PART_4 (2).txt" — is the
# EXACT file that hit this EXACT error in the ORIGINAL 2026-06-12/13 incident
# report.
#
# ROOT CAUSE THEORY (from reading lib/inbox-watcher.ts):
#   - startInboxWatcher() creates ./inbox, ./inbox/done, ./inbox/failed via
#     mkdirSync ONCE at app startup.
#   - After processing a file (rows already imported into ulp.credentials),
#     enqueueFile() does:
#       fs.renameSync(filePath, path.join(DONE, filename))   // success path
#     and on error:
#       try { fs.renameSync(filePath, path.join(FAIL, filename)) } catch {}
#   - fs.renameSync() requires the DESTINATION's parent directory to exist.
#     If ./inbox/done and/or ./inbox/failed were deleted on the HOST (e.g.
#     while reorganizing files for re-import) WITHOUT restarting the
#     ulpsuite_app container, BOTH renames throw ENOENT — the second one is
#     silently swallowed by `catch {}`.
#   - The file is left sitting in ./inbox/. The `finally` block still runs
#     inFlight.delete(filename), so the file is no longer tracked as
#     in-flight.
#   - The next reconcile() (every 30s) sees the file still in ./inbox/, not
#     in inFlight -> re-queues it -> reprocesses it -> re-imports ALL of its
#     rows into ulp.credentials again (insert_deduplicate=0) -> fails the
#     same rename again -> forever.
#   - recordSource() correctly skips re-inserting into ulp.sources after the
#     first successful pass (its idempotency check), so ulp.sources looks
#     normal even while ulp.credentials silently grows every ~30s+ cycle.
#
# This matches every observed detail: the error shape (rename ENOENT),
# multiple unrelated files affected (not filename-specific), non-zero
# imported counts before the failure, and — critically — the SAME file
# recurring from the original incident (it's been stuck in this loop ever
# since, possibly for hours).
#
# A code-level hardening fix (defensive mkdirSync(DONE/FAIL, {recursive:true})
# before each rename) has been committed to lib/inbox-watcher.ts — it will
# take effect on the next image rebuild. THIS script fixes the live
# container right now, without a rebuild.
#
# This script:
#   1. (read-only) Confirms whether ./inbox/done and ./inbox/failed exist,
#      host-side and container-side (same bind mount — should agree).
#   2. (read-only) Lists ./inbox/ root — are the 5 files still sitting there,
#      stuck in the loop?
#   3. (read-only) Recent [inbox-watcher] log lines + ENOENT-rename count —
#      look for repeating queued/processing/failed cycles for the same files.
#   4. (read-only) ulp.sources — most recent 15 entries (sanity check: one
#      row per filename even if ulp.credentials has been duplicated many
#      times over).
#   5. (read-only) ulp.credentials INSERT activity in the last hour
#      (system.query_log) + most-recently-modified active parts — direct
#      evidence of an active reprocessing cadence.
#   6. (read-only) Currently-running queries touching `credentials`
#      (system.processes) — relevant to the separate "StarX..." file stuck
#      at 0 rows / 20+ min in the UI.
#   7. (read-only) Recent log lines mentioning "StarX" — same purpose.
#   8. *** THE FIX *** mkdir -p ./inbox/done ./inbox/failed — host-side,
#      idempotent. SAFE EVEN IF THE HYPOTHESIS ABOVE IS WRONG: these
#      directories should exist regardless, and creating an already-existing
#      directory is a complete no-op.
#   9. Verify: dirs now exist, host + container. The next reconcile() (within
#      30s) will reprocess the 5 stuck files ONE more time (one more
#      duplicate-row pass each — unavoidable, the rows are already
#      mid-flight) but THIS TIME the rename to done/ will succeed, so they
#      finally leave ./inbox/ and the loop stops.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/fix-inbox-rename-loop.sh
# =============================================================================

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at $PROJECT_DIR"
  exit 1
fi
cd "$PROJECT_DIR"

CH="docker exec ulpsuite_clickhouse clickhouse-client --query"
REPORT="/tmp/ulp-fix-inbox-rename-loop-$(date +%Y%m%d-%H%M%S).txt"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — fix inbox rename loop                          ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/9  Do ./inbox/done and ./inbox/failed exist? ═════════════════"
echo "-- host (./inbox/) --"
ls -ld inbox/done inbox/failed 2>&1
echo ""
echo "-- container (/app/inbox/, same bind mount — should agree) --"
docker exec ulpsuite_app ls -ld /app/inbox/done /app/inbox/failed 2>&1
echo ""

echo "═══ 2/9  ./inbox/ root contents (stuck files would be here) ════════"
ls -la inbox/ 2>&1 | grep -v '^total'
echo ""

echo "═══ 3/9  Recent [inbox-watcher] log activity ═══════════════════════"
echo "-- last 100 [inbox-watcher] lines (of last 5000 app log lines) --"
docker compose logs app --tail=5000 2>/dev/null | grep -i '\[inbox-watcher\]' | tail -100
echo ""
echo "-- ENOENT rename-failure count in last 5000 app log lines --"
docker compose logs app --tail=5000 2>/dev/null | grep -c "ENOENT: no such file or directory, rename" || echo "0"
echo ""

echo "═══ 4/9  ulp.sources — most recent 15 entries ══════════════════════"
$CH "SELECT filename, line_count, imported_at FROM ulp.sources ORDER BY imported_at DESC LIMIT 15" --format PrettyCompact
echo ""

echo "═══ 5/9  ulp.credentials INSERT activity in the last hour ══════════"
echo "-- INSERT INTO ulp.credentials: count + total rows written (last 1h) --"
$CH "
SELECT count() AS insert_queries, sum(written_rows) AS total_rows_written,
       min(event_time) AS earliest, max(event_time) AS latest
FROM system.query_log
WHERE type = 'QueryFinish' AND query ILIKE 'INSERT INTO ulp.credentials%'
  AND event_time > now() - INTERVAL 1 HOUR
" --format PrettyCompact
echo ""
echo "-- most recently modified active parts --"
$CH "
SELECT name, rows, formatReadableSize(bytes_on_disk) AS size, modification_time
FROM system.parts
WHERE database = 'ulp' AND table = 'credentials' AND active = 1
ORDER BY modification_time DESC
LIMIT 8
" --format PrettyCompact
echo ""

echo "═══ 6/9  Currently-running queries touching 'credentials' ═════════"
$CH "
SELECT query_id, elapsed, read_rows, written_rows, left(query, 200) AS query_preview
FROM system.processes
WHERE query ILIKE '%credentials%' AND query NOT ILIKE '%system.processes%'
ORDER BY elapsed DESC
" --format PrettyCompact
echo ""

echo "═══ 7/9  Recent log lines mentioning 'StarX' (stuck-processing file) ═"
docker compose logs app --tail=5000 2>/dev/null | grep -i "starx" | tail -40
echo ""

echo "═══ 8/9  THE FIX: mkdir -p ./inbox/done ./inbox/failed (idempotent) ═"
echo "(safe even if section 1 showed these already exist — mkdir -p on an"
echo " existing directory is a complete no-op)"
mkdir -p inbox/done inbox/failed
echo "mkdir -p inbox/done inbox/failed -> exit code $?"
echo ""

echo "═══ 9/9  Verify ═════════════════════════════════════════════════════"
echo "-- host --"
ls -ld inbox/done inbox/failed 2>&1
echo ""
echo "-- container (should match immediately — same bind mount) --"
docker exec ulpsuite_app ls -ld /app/inbox/done /app/inbox/failed 2>&1
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 1: if done/ and/or failed/ were MISSING, that's the smoking"
echo "    gun — confirms the hypothesis above."
echo "  - Section 2: are the 5 stuck files still in ./inbox/ right now?"
echo "  - Section 3: do you see repeating 'queued: <file>' / 'processing:"
echo "    <file>' / 'failed: <file> ... ENOENT' cycles for the SAME"
echo "    filenames — i.e. a loop, not a one-off?"
echo "  - Section 4: ulp.sources should show ONE row per affected filename"
echo "    (recordSource's idempotency check working as designed) even if"
echo "    ulp.credentials has been duplicated many times over."
echo "  - Section 5: a large insert_queries count / total_rows_written in"
echo "    just the last hour, and a very recently modified part, both point"
echo "    to an active reprocessing loop eating CPU/IO/disk continuously."
echo "  - Section 6/7: any clue about the StarX file stuck at 0 rows for"
echo "    20+ min — e.g. a long-running INSERT, or no log activity at all"
echo "    (suggesting it's stuck in the parser before the first batch)."
echo "  - Section 8/9: the fix — done/ and failed/ now exist (host + "
echo "    container). Within ~30s the next reconcile() will reprocess the 5"
echo "    stuck files ONE final time (one more duplicate-row pass each,"
echo "    unavoidable) but THIS TIME the rename should succeed, moving them"
echo "    to done/ and ending the loop."
echo ""
echo "After ~1 minute, re-check the Inbox Monitor UI: the 'Processing'"
echo "entries for these 5 files should stop reappearing, and they should"
echo "land in done/ instead of repeating in the failed list."
echo ""
echo "Separately: ulp.credentials now likely has duplicate rows for these 5"
echo "files (one extra copy per loop iteration since whenever this started)."
echo "That's a follow-up cleanup — share this output first and we'll figure"
echo "out how many iterations happened and how to dedupe safely."
echo "═══════════════════════════════════════════════════════════════"
