#!/bin/bash
# =============================================================================
# diagnose-inbox-duplicates.sh
#
# READ-ONLY. Checks whether files currently sitting in ./inbox (or
# ./inbox/failed) were ALREADY imported before the 2026-06-12/13 incident —
# i.e. their credentials are likely already part of the restored 1.46B-row
# 202605 partition of ulp.credentials.
#
# Why this matters:
#   - ulp.credentials is a plain MergeTree, and lib/upload-processor.ts'
#     insertBatch() sets insert_deduplicate=0. There is NO engine-level
#     protection against re-importing the same file twice.
#   - recordSource() in lib/upload-processor.ts checks ulp.sources before
#     inserting a row THERE, but that only dedups the audit log — it does
#     NOT skip the actual credential insert. If the inbox watcher reprocesses
#     a file whose filename is already in ulp.sources, every row gets
#     duplicated into ulp.credentials.
#   - ulp.sources.filename is therefore the authoritative "already imported"
#     signal:
#       - for .txt/.csv files: the filename itself
#       - for .zip files: each internal .txt/.csv entry name is recorded
#         individually (processZipEntries -> processTextStream(entryName)
#         -> recordSource(entryName, ...)), so we list zip entries and check
#         each one.
#
# This script:
#   1. Lists ./inbox (waiting), ./inbox/failed, and ./inbox/done count
#   2. Shows ulp.sources totals + most recent entries for context
#   3. For each .txt/.csv/.zip file in inbox/ and inbox/failed/, checks
#      ulp.sources and prints a verdict: ALREADY IMPORTED (duplicate risk)
#      vs NEW (safe to process)
#
# Nothing is moved, deleted, or modified. Zip files are only listed (their
# central directory is read), never extracted.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host running this stack):
#   bash scripts/diagnose-inbox-duplicates.sh
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
REPORT="/tmp/ulp-inbox-duplicates-$(date +%Y%m%d-%H%M%S).txt"

exec > >(tee "$REPORT") 2>&1

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — inbox vs. ulp.sources duplicate check (RO)     ║"
echo "║   Report: $REPORT"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Generated: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "═══ 1/3  ./inbox contents ════════════════════════════════════════"
echo "-- inbox/ (waiting to be processed) --"
ls -la inbox/ 2>/dev/null | grep -v '^total' || echo "  (inbox/ not found or empty)"
echo ""
echo "-- inbox/failed/ --"
ls -la inbox/failed/ 2>/dev/null | grep -v '^total' || echo "  (none)"
echo ""
echo "-- inbox/done/ file count --"
ls -1 inbox/done/ 2>/dev/null | wc -l
echo ""

echo "═══ 2/3  ulp.sources summary ═════════════════════════════════════"
$CH "SELECT count() AS total_sources FROM ulp.sources" --format PrettyCompact
echo ""
echo "-- most recent 15 entries --"
$CH "SELECT filename, line_count, imported_at FROM ulp.sources ORDER BY imported_at DESC LIMIT 15" --format PrettyCompact
echo ""

echo "═══ 3/3  Per-file check: inbox/ + inbox/failed/ vs ulp.sources ═══"

# check_filename FNAME CONTEXT
# Looks up FNAME in ulp.sources and prints a verdict.
check_filename() {
  local fname="$1"
  local context="$2"
  local escaped
  escaped=$(printf '%s' "$fname" | sed "s/'/''/g")
  local result
  result=$($CH "SELECT filename, line_count, imported_at FROM ulp.sources WHERE filename = '$escaped' LIMIT 1" --format TSV 2>/dev/null)
  if [ -n "$result" ]; then
    echo "  [$context] '$fname'"
    echo "      -> ALREADY IN ulp.sources ($result)"
    echo "      -> DUPLICATE RISK if reprocessed"
  else
    echo "  [$context] '$fname' -> not in ulp.sources -> looks NEW, likely safe"
  fi
}

# list_zip_entries SUBDIR FNAME
# Prints one .txt/.csv entry name per line from the zip at inbox/<SUBDIR><FNAME>
# (SUBDIR is '' or 'failed/'), via node+yauzl inside the app container.
# yauzl only reads the central directory — nothing is extracted to disk.
list_zip_entries() {
  local subdir="$1"
  local fname="$2"
  docker exec -e ZIPDIR="$subdir" -e ZIPNAME="$fname" ulpsuite_app node -e '
    const yauzl = require("yauzl");
    const path  = "/app/inbox/" + (process.env.ZIPDIR || "") + process.env.ZIPNAME;
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err) { console.error("  (could not open zip: " + err.message + ")"); process.exit(0); }
      zip.on("entry", (e) => {
        if (!/\/$/.test(e.fileName)) {
          const lp = e.fileName.toLowerCase();
          if (lp.endsWith(".txt") || lp.endsWith(".csv")) {
            console.log(e.fileName.split("/").pop());
          }
        }
        zip.readEntry();
      });
      zip.on("end", () => process.exit(0));
      zip.on("error", (e) => { console.error("  (zip error: " + e.message + ")"); process.exit(0); });
      zip.readEntry();
    });
  ' 2>/dev/null
}

# process_dir SUBDIR (relative to ./inbox, '' or 'failed/')
process_dir() {
  local subdir="$1"
  local label="$2"
  local dir="inbox/${subdir}"
  local any=0
  for f in "$dir"*; do
    [ -f "$f" ] || continue
    any=1
    name=$(basename "$f")
    lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      *.zip)
        echo "  '$name' ($label) is a .zip — checking internal .txt/.csv entries:"
        entries=$(list_zip_entries "$subdir" "$name")
        if [ -z "$entries" ]; then
          echo "      (no .txt/.csv entries found, or zip unreadable)"
        else
          while IFS= read -r entry; do
            [ -n "$entry" ] && check_filename "$entry" "zip:$name"
          done <<< "$entries"
        fi
        ;;
      *.txt|*.csv)
        check_filename "$name" "$label"
        ;;
      *)
        echo "  '$name' ($label) — unrecognized extension, skipping"
        ;;
    esac
  done
  if [ "$any" -eq 0 ]; then
    echo "  (no files in $dir)"
  fi
}

echo "-- inbox/ (waiting) --"
process_dir "" "inbox"
echo ""
echo "-- inbox/failed/ --"
process_dir "failed/" "failed"
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "Full report written to: $REPORT"
echo ""
echo "What to do with the results:"
echo "  - Any file/entry flagged 'ALREADY IN ulp.sources' would create"
echo "    duplicate rows in ulp.credentials if the inbox watcher processes it"
echo "    (or re-processes it). Move it out of inbox/ (e.g. into inbox/done/"
echo "    manually, or just delete it from inbox/ if a copy exists elsewhere)"
echo "    BEFORE letting the watcher run, or BEFORE using 'Retry' on it in"
echo "    the /inbox UI."
echo "  - Files flagged 'not in ulp.sources -> looks NEW' should be safe to"
echo "    process normally."
echo "  - For .zip files where entries couldn't be listed, share the error"
echo "    output before proceeding — don't guess."
echo "═══════════════════════════════════════════════════════════════"
