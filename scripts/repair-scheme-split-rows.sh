#!/usr/bin/env bash
# Append corrected copies of the "scheme-split" legacy rows of ulp.credentials (see lib/legacy-repair.ts).
#
#   bash scripts/repair-scheme-split-rows.sh            # dry run: re-parses every candidate, reports counts, writes nothing
#   APPLY=1 bash scripts/repair-scheme-split-rows.sh    # appends the repaired rows
#
# What it is: 3.29M rows (July-August 2026) were stored as url='https', email='//host/path', password='login|pass', domain=''
# by an older parser, so no domain/email filter and no monitor can see them. The ORIGINAL line is recoverable
# (url + ':' + email + '|' + password) and the current parser reads it correctly, under the importer's own ingest policy
# (read from the running app, so a row the importer would reject today is not re-introduced). A repair must reproduce the
# stored fields exactly, or the row is left alone.
#
# What it does NOT do: touch an existing row. The old rows are already hidden by Declutter (single-label host) and a
# partition rewrite is not something to run on a table with no backup. The corrected rows are only APPENDED, keeping each
# row's imported_at, source_file and breach_name, into a scratch table first (ulp.zz_scheme_split_repaired, dropped on exit),
# and a corrected credential whose content key is already in ulp.credentials is skipped, so a re-run appends nothing.
# New matches on a watched domain will be found by the domain monitor's next rescan.
#
# Refuses (exit 2, nothing changed) while another mutation runs, with under MIN_FREE_GIB free disk, or if a scratch table
# from an earlier run is still there. Exit: 0 ok | 1 environment | 2 precondition | 6 verification failed.
# Counts only on screen; the repaired rows (they hold passwords) live in a private temp dir that is removed on exit.
# Needs `npm ci` in this checkout (tsx).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APPLY="${APPLY:-0}"
MIN_FREE_GIB="${MIN_FREE_GIB:-50}"
CONTAINER="${CLICKHOUSE_CONTAINER:-ulpsuite_clickhouse}"
APP_CONTAINER="${APP_CONTAINER:-ulpsuite_app}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
TSX_BIN="${TSX_BIN:-$PROJECT_DIR/node_modules/.bin/tsx}"
SCRATCH="ulp.zz_scheme_split_repaired"

cd "$PROJECT_DIR"

if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable in this shell." >&2
  exit 1
fi
if ! "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: ClickHouse container '$CONTAINER' is not running." >&2
  exit 1
fi
if ! "$DOCKER_BIN" inspect "$APP_CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: app container '$APP_CONTAINER' is not running; the ingest policy is read from it." >&2
  exit 1
fi
if [[ ! -x "$TSX_BIN" ]]; then
  echo "ERROR: $TSX_BIN is missing (run 'npm ci' in $PROJECT_DIR)." >&2
  exit 1
fi

ch()       { "$DOCKER_BIN" exec "$CONTAINER" clickhouse-client --query "$1"; }
ch_stdin() { "$DOCKER_BIN" exec -i "$CONTAINER" clickhouse-client --async_insert=0 --query "$1"; }

WORK="$(umask 077 && mktemp -d)"
scratch_created=0
cleanup() {
  rm -rf "$WORK"
  if [[ "$scratch_created" == "1" ]]; then
    ch "DROP TABLE IF EXISTS $SCRATCH SYNC" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "ULP Suite - scheme-split legacy row repair"
echo "APPLY=$APPLY (0 = dry run)"
echo

PREDICATE="$("$TSX_BIN" -e "import { SCHEME_SPLIT_PREDICATE as p } from './lib/legacy-repair'; process.stdout.write(p)")"
if [[ -z "$PREDICATE" ]]; then
  echo "ERROR: could not read the scheme-split predicate." >&2
  exit 1
fi

# The ingest policy in force is the RUNNING app's, not the repo default.
HARD_TIERS="$("$DOCKER_BIN" exec "$APP_CONTAINER" printenv INGEST_FILTER_HARD_DROP_TIERS 2>/dev/null || true)"
DROP_TIERS="$("$DOCKER_BIN" exec "$APP_CONTAINER" printenv INGEST_FILTER_DROP_TIERS 2>/dev/null || true)"
DROP_NOISE="$("$DOCKER_BIN" exec "$APP_CONTAINER" printenv INGEST_FILTER_DROP_NOISE 2>/dev/null || true)"
DROP_SUFFIXES="$("$DOCKER_BIN" exec "$APP_CONTAINER" printenv INGEST_FILTER_DROP_SUFFIXES 2>/dev/null || true)"
KEEP_SUFFIXES="$("$DOCKER_BIN" exec "$APP_CONTAINER" printenv INGEST_FILTER_KEEP_SUFFIXES 2>/dev/null || true)"
echo "ingest policy (from $APP_CONTAINER): hard-drop tiers='${HARD_TIERS}' drop tiers='${DROP_TIERS}' drop noise='${DROP_NOISE}'"

pending="$(ch "SELECT count() AS pending_mutations FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done FORMAT TSVRaw")"
pending="${pending:-0}"
if (( pending > 0 )); then
  echo "ERROR: $pending mutation(s) are still running on ulp.credentials (a backfill?). Wait for them, then run this again." >&2
  exit 2
fi
free_gib="$(ch "SELECT toUInt64(floor(free_space / 1073741824)) AS free_gib FROM system.disks WHERE name = 'default' FORMAT TSVRaw")"
free_gib="${free_gib:-0}"
if (( free_gib < MIN_FREE_GIB )); then
  echo "ERROR: only $free_gib GiB free; need at least $MIN_FREE_GIB GiB (MIN_FREE_GIB)." >&2
  exit 2
fi
leftover="$(ch "SELECT count() AS scratch_exists FROM system.tables WHERE database = 'ulp' AND name = 'zz_scheme_split_repaired' FORMAT TSVRaw")"
if [[ "${leftover:-0}" != "0" ]]; then
  echo "ERROR: $SCRATCH exists from an earlier run. Look at it (and drop it) before running this again." >&2
  exit 2
fi

candidates="$(ch "SELECT count() AS candidate_rows FROM ulp.credentials WHERE $PREDICATE FORMAT TSVRaw")"
candidates="${candidates:-0}"
echo "candidate rows (scheme-split shape): $candidates"
if (( candidates == 0 )); then
  echo "Nothing to repair."
  exit 0
fi

# Re-parse every candidate with the current parser under the importer's policy.
echo
echo "Re-parsing $candidates rows..."
mode=(--count-only)
[[ "$APPLY" == "1" ]] && mode=(--out "$WORK/repaired.jsonl")
report="$(
  ch "SELECT url, email, password, source_file, breach_name, imported_at FROM ulp.credentials WHERE $PREDICATE FORMAT TSV" |
    INGEST_FILTER_HARD_DROP_TIERS="$HARD_TIERS" INGEST_FILTER_DROP_TIERS="$DROP_TIERS" INGEST_FILTER_DROP_NOISE="$DROP_NOISE" \
    INGEST_FILTER_DROP_SUFFIXES="$DROP_SUFFIXES" INGEST_FILTER_KEEP_SUFFIXES="$KEEP_SUFFIXES" \
    "$TSX_BIN" "$SCRIPT_DIR/repair-scheme-split-rows.ts" "${mode[@]}"
)"
echo "$report"
repaired="$(sed -n 's/.*repair-result: candidates=[0-9]* repaired=\([0-9][0-9]*\).*/\1/p' <<<"$report" | tail -1)"
if [[ -z "$repaired" ]]; then
  echo "ERROR: the repair step printed no verdict line." >&2
  exit 6
fi

if [[ "$APPLY" != "1" ]]; then
  echo
  echo "Dry run: nothing was changed. Run again with APPLY=1 to append the $repaired repaired rows."
  exit 0
fi
if (( repaired == 0 )); then
  echo "Nothing to append."
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────────
KEY_EXPR="$(ch "SELECT default_expression AS key_expression FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'content_key_hash' FORMAT TSVRaw")"
if [[ -z "$KEY_EXPR" ]]; then
  echo "ERROR: could not read the content_key_hash expression from ulp.credentials." >&2
  exit 1
fi

echo
echo "Staging $repaired repaired rows in $SCRATCH..."
scratch_created=1
ch "CREATE TABLE $SCRATCH (url String, email String, password String, domain String, source_file String, breach_name String, imported_at DateTime, content_key_hash UInt64 MATERIALIZED $KEY_EXPR) ENGINE = MergeTree ORDER BY content_key_hash"
ch_stdin "INSERT INTO $SCRATCH (url, email, password, domain, source_file, breach_name, imported_at) FORMAT JSONEachRow" < "$WORK/repaired.jsonl"

IFS=$'\t' read -r scratch_rows scratch_keys <<<"$(ch "SELECT count() AS scratch_rows, uniqExact(content_key_hash) AS scratch_keys FROM $SCRATCH FORMAT TSV")"
echo "staged: $scratch_rows rows, $scratch_keys distinct credentials"
if [[ "${scratch_rows:-x}" != "$repaired" ]]; then
  echo "ERROR: the scratch table holds ${scratch_rows:-nothing} rows but $repaired were repaired; nothing was appended." >&2
  exit 6
fi

already="$(ch "SELECT count() AS already_present FROM $SCRATCH WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.credentials WHERE content_key_hash IN (SELECT content_key_hash FROM $SCRATCH)) FORMAT TSVRaw")"
echo "already in ulp.credentials (skipped): ${already:-0}"

echo "Appending..."
ch "INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name, imported_at) SELECT url, email, password, domain, source_file, breach_name, imported_at FROM $SCRATCH WHERE content_key_hash NOT IN (SELECT content_key_hash FROM ulp.credentials WHERE content_key_hash IN (SELECT content_key_hash FROM $SCRATCH)) ORDER BY imported_at LIMIT 1 BY content_key_hash SETTINGS async_insert = 0, max_execution_time = 3600"

present="$(ch "SELECT count() AS keys_present FROM ulp.credentials WHERE content_key_hash IN (SELECT content_key_hash FROM $SCRATCH) FORMAT TSVRaw")"
if [[ "${present:-x}" != "$scratch_keys" ]]; then
  echo "ERROR: ${present:-?} of $scratch_keys repaired credentials are in ulp.credentials: some are missing." >&2
  exit 6
fi
echo "appended: $(( scratch_keys - ${already:-0} )) repaired rows (every one of the $scratch_keys repaired credentials is now in ulp.credentials)."
echo "The domain monitor picks up new matches at its next rescan."
