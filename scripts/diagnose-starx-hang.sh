#!/bin/bash
# =============================================================================
# diagnose-starx-hang.sh
#
# READ-ONLY. Investigates StarX_ULP_19.12.2025_Part_2.txt (1.9GB), shown by
# the Inbox Monitor UI as "Processing... 0 rows imported... parsing first
# batch... Elapsed: 20m+" with ZERO [inbox-watcher] log activity in
# `docker compose logs app --tail=5000` and ZERO running queries in
# system.processes touching `credentials`.
#
# Hypothesis #1 (missing ./inbox/done|failed dirs causing the earlier
# rename-loop) was checked separately and REFUTED — both dirs exist with
# correct ownership/permissions, host and container. This is a NEW, separate
# investigation.
#
# CODE-LEVEL HYPOTHESIS #2 (from reading lib/ulp-parser.ts's parseULPStream,
# which processTextStream uses for non-zip inbox files):
#
#   while (true) {
#     const { done, value } = await reader.read()   // ~64KB chunks
#     if (done) break
#     buffer += Buffer.from(value).toString('latin1')
#     const lines = buffer.split('\n')               // <-- re-scans WHOLE buffer
#     buffer = lines.pop() ?? ''                     // last (incomplete) line
#     for (const line of lines) {
#       processLine(line)
#       if (batch.length >= batchSize) yield flushBatch()
#     }
#   }
#
#   If `buffer` ever contains ZERO '\n' bytes (a long run of binary/non-text
#   data, or one pathologically long "line"), buffer.split('\n') returns
#   [buffer] as ONE element. lines.pop() hands the WHOLE buffer back to
#   itself, lines becomes [] -> processLine is NEVER called -> batch stays
#   empty -> imported stays 0 -> onBatch never fires -> UI shows "0 rows"
#   forever, and insertBatch (and thus ClickHouse) is never reached.
#
#   Meanwhile buffer keeps GROWING by ~64KB per read(), and split('\n')
#   RE-SCANS THE ENTIRE GROWING BUFFER every iteration — O(n^2). For a
#   multi-hundred-MB no-newline span, that's potentially many minutes to
#   hours of pure CPU-bound string scanning. This matches "0 rows, 20+ min,
#   no errors, nothing in system.processes" exactly.
#
#   THE KEY DIFFERENTIATOR vs. a genuine stream/await-level hang (e.g. a
#   Readable.toWeb backpressure issue, where reader.read() itself never
#   resolves): this hypothesis predicts the ulpsuite_app node process is
#   BUSY — one CPU core near 100%, process state R (running). A stream-level
#   hang would instead show ~0% CPU, state S (sleeping/idle).
#
# This script:
#   1. (read-only) Container uptime/restart count — rule out "just restarted,
#      in-memory progress state was reset".
#   2. (read-only) docker stats snapshot — CPU%/MEM% for both containers.
#   3. (read-only) ps inside ulpsuite_app, TWO samples 3s apart — PID, STAT,
#      %CPU, ELAPSED for the node process — THE key test above.
#   4. (read-only) curl http://localhost:3000/api/inbox/status — raw live
#      JSON (rows_imported, started_at, file_size_bytes, in-flight count).
#   5. (read-only) docker compose logs app --since=2h | grep -iE
#      'inbox-watcher|starx' — wider window than the earlier tail=5000.
#   6. (read-only) Newline density at 9 points spread across the 1.9GB file —
#      a healthy ~50-150 byte/line text file has tens of thousands of '\n'
#      per 5MB window. Near-zero at any point pinpoints a no-newline span —
#      direct confirmation of the hypothesis.
#   7. (read-only) `file` + wc -l/-c on the StarX file (wc is a fast linear C
#      scan — seconds for 1.9GB, NOT the JS O(n^2) issue).
#   8. (read-only) ulp.sources — confirm StarX has NEVER recorded a
#      successful import (imported has been 0 the entire time, not just now).
#
# NO FIX is applied by this script. If section 3 shows sustained high CPU +
# state R, and section 6 finds a near-zero-newline window, that CONFIRMS the
# O(n^2) buffer/split hypothesis — the fix (cap buffer size so an oversized
# "line" is rejected in bounded time/memory instead of re-scanned forever)
# can then be applied to lib/ulp-parser.ts with confidence. Applying it will
# require rebuilding/restarting ulpsuite_app, which would also restart StarX's
# processing from scratch — a separate step, not taken here.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-starx-hang.sh
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
REPORT="/tmp/ulp-diagnose-starx-hang-$(date +%Y%m%d-%H%M%S).txt"
STARX="inbox/StarX_ULP_19.12.2025_Part_2.txt"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — diagnose StarX hang (read-only)                ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/8  Container uptime / restart count ══════════════════════════"
docker inspect ulpsuite_app --format 'StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}} Status={{.State.Status}}'
echo ""

echo "═══ 2/8  docker stats snapshot (CPU%/MEM%) ═════════════════════════"
docker stats --no-stream ulpsuite_app ulpsuite_clickhouse
echo ""

echo "═══ 3/8  Node process state inside ulpsuite_app (THE key test) ════"
echo "-- sample 1 --"
docker exec ulpsuite_app ps -eo pid,ppid,stat,%cpu,%mem,etime,cmd --sort=-%cpu | head -8
echo ""
echo "(waiting 3s for a second sample — sustained high %CPU + STAT=R confirms"
echo " active CPU-bound work; ~0%CPU + STAT=S points to an idle/blocked wait)"
sleep 3
echo "-- sample 2 --"
docker exec ulpsuite_app ps -eo pid,ppid,stat,%cpu,%mem,etime,cmd --sort=-%cpu | head -8
echo ""

echo "═══ 4/8  Live /api/inbox/status (raw JSON) ═════════════════════════"
curl -s http://localhost:3000/api/inbox/status
echo ""
echo ""

echo "═══ 5/8  [inbox-watcher] / StarX log lines in the last 2 hours ═════"
docker compose logs app --since=2h 2>/dev/null | grep -iE '\[inbox-watcher\]|starx' | tail -60
echo ""

echo "═══ 6/8  Newline density across the file (9 points, 5MB windows) ══="
echo "(healthy ~50-150 byte/line text -> tens of thousands of newlines per"
echo " 5MB window. Near-zero at any point -> no-newline span at that offset.)"
FILESIZE=$(stat -c%s "$STARX" 2>/dev/null || echo 0)
echo "file size: $FILESIZE bytes"
if [ "$FILESIZE" -gt 0 ]; then
  for i in 0 1 2 3 4 5 6 7 8; do
    OFFSET=$(( FILESIZE * i / 8 ))
    if [ "$OFFSET" -gt $(( FILESIZE - 5000000 )) ]; then OFFSET=$(( FILESIZE - 5000000 )); fi
    if [ "$OFFSET" -lt 0 ]; then OFFSET=0; fi
    NL=$(tail -c +$((OFFSET+1)) "$STARX" | head -c 5000000 | tr -cd '\n' | wc -c)
    PCT=$(( i * 100 / 8 ))
    echo "  offset ${OFFSET} (~${PCT}%): ${NL} newlines in next 5MB"
  done
else
  echo "  (file not found at $STARX — has it moved? checking inbox/ root)"
  ls -la inbox/ 2>&1 | grep -v '^total'
fi
echo ""

echo "═══ 7/8  file type + total line/byte counts (fast C-level scan) ═══"
file "$STARX" 2>&1
echo "wc (lines / bytes) — may take ~10-30s for 1.9GB:"
wc -lc "$STARX" 2>&1
echo ""

echo "═══ 8/8  ulp.sources — has StarX ever recorded a successful import? ═"
$CH "SELECT filename, line_count, imported_at FROM ulp.sources WHERE filename ILIKE '%StarX%'" --format PrettyCompact
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What this tells us:"
echo "  - Section 3: if %CPU is high (near 100 on one core) and STAT is 'R'"
echo "    (or 'R+'), CONSISTENTLY across both samples, the node process is"
echo "    BUSY computing — supports the O(n^2) buffer/split hypothesis. If"
echo "    %CPU is ~0 and STAT is 'S'/'D', the process is IDLE/blocked —"
echo "    points to a stream-level hang instead (different root cause,"
echo "    different fix)."
echo "  - Section 4: confirms the live elapsed time / rows_imported the UI"
echo "    is showing, straight from the source."
echo "  - Section 5: do the 'queued:'/'processing:' log lines for StarX"
echo "    actually exist (just outside the earlier tail=5000 window), and"
echo "    is there any 'done:'/'failed:' (there shouldn't be)?"
echo "  - Section 6: a near-zero count at any offset directly locates a"
echo "    no-newline span — the trigger for the hypothesis above. All"
echo "    windows healthy would argue AGAINST this hypothesis."
echo "  - Section 7: does 'file' call this 'ASCII text' or something else"
echo "    (e.g. 'data')? Do wc -l and wc -c roughly agree with a sane"
echo "    average line length (file_size / line_count)?"
echo "  - Section 8: expected EMPTY — confirms imported has been 0 the"
echo "    entire time (no partial success already recorded)."
echo ""
echo "Share the output and, if sections 3+6 point to the O(n^2) hypothesis,"
echo "I'll write the fix for lib/ulp-parser.ts (cap buffer size so an"
echo "oversized 'line' is rejected in bounded time instead of re-scanned"
echo "forever) — no action taken on the live system yet."
echo "═══════════════════════════════════════════════════════════════"
