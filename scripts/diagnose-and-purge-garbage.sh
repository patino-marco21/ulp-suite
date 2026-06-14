#!/bin/bash
# =============================================================================
# diagnose-and-purge-garbage.sh
#
# Finds (and optionally deletes) the binary / mis-encoded / fake-URL garbage
# rows in ulp.credentials -- the https://0Z, https:////, mojibake-host, and
# U+FFFD junk that the pre-fix parser manufactured from non-credential source
# data (IPTV configs, encrypted blobs, non-UTF-8 text). The parser fix (commit
# 1d0728c) stops NEW garbage; this cleans the existing backlog.
#
# A row is GARBAGE if:
#   (a) url is http(s) but its host isn't a real hostname (domain(url) fails a
#       Unicode-aware dot-separated-label check) AND the email isn't a real
#       email (so there's nothing salvageable). App schemes (android://) and
#       scheme-less hosts are NOT touched, mirroring the parser.
#   (b) any of url/email/password contains a control byte (excl. tab/LF/CR) or
#       the U+FFFD replacement char -- a sure sign of binary/mis-encoded input.
#
# Rows with a junk url but a REAL email are PRESERVED (the parser salvages
# those as email:password; deleting them would lose a real credential).
#
# DEFAULT = read-only: counts garbage, shows the breakdown, samples matched
# rows (verify the condition is catching junk, not real data) and preserved
# rows. NOTHING is deleted unless you pass PURGE=1.
#
#   bash scripts/diagnose-and-purge-garbage.sh            # diagnose only (safe)
#   PURGE=1 bash scripts/diagnose-and-purge-garbage.sh    # delete the garbage
#
# PURGE fires ALTER TABLE ... DELETE (a background mutation; url/email/password
# are not key columns so the delete is allowed). It does NOT block -- monitor
# with system.mutations, then re-run the default to watch the count fall.
# Consider taking a backup first (the dedup pattern makes credentials_old), or
# just trust the samples below before purging.
#
# Usage (from ~/ulp-suite on the Ubuntu Docker host):
#   bash scripts/diagnose-and-purge-garbage.sh
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
PURGE="${PURGE:-0}"

# The GARBAGE predicate. Single-quoted heredoc keeps backslashes literal (two
# backslashes -> ClickHouse unescapes to one, the form RE2 needs). Interpolated
# into double-quoted query strings below (bash does not re-process backslashes
# from an expanded variable's value).
IS_GARBAGE=$(cat <<'EOF'
(
  ( match(url, '^https?://')
    AND NOT match(domain(url), '^[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(\\.[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+$')
    AND NOT match(email, '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$') )
  OR match(url,      '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR match(email,    '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR match(password, '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]')
  OR position(url,      unhex('EFBFBD')) > 0
  OR position(email,    unhex('EFBFBD')) > 0
  OR position(password, unhex('EFBFBD')) > 0
)
EOF
)

# Preserved-but-suspect: junk url with a REAL email (parser would salvage these
# by blanking the url; this script keeps them).
SALVAGEABLE=$(cat <<'EOF'
( match(url, '^https?://')
  AND NOT match(domain(url), '^[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?(\\.[\\p{L}\\p{N}]([\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?)+$')
  AND match(email, '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$') )
EOF
)

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — diagnose/purge garbage rows                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "PURGE=$PURGE  (default 0 = read-only)"
echo ""

echo "═══ 1/5  Garbage count + breakdown ══════════════════════════════"
$CH "
SELECT
  count() AS total_rows,
  countIf($IS_GARBAGE) AS garbage_rows,
  round(100.0 * countIf($IS_GARBAGE) / count(), 3) AS pct_garbage,
  countIf($SALVAGEABLE) AS salvageable_kept
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""

echo "═══ 2/5  Sub-signals (which rule fires) ═════════════════════════"
$CH "
SELECT
  countIf(match(url, '^https?://') AND NOT match(domain(url), '^[\\\\p{L}\\\\p{N}]([\\\\p{L}\\\\p{N}-]*[\\\\p{L}\\\\p{N}])?(\\\\.[\\\\p{L}\\\\p{N}]([\\\\p{L}\\\\p{N}-]*[\\\\p{L}\\\\p{N}])?)+\$')) AS bad_host_any,
  countIf(match(url, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]') OR match(email, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]') OR match(password, '[\\\\x00-\\\\x08\\\\x0B\\\\x0C\\\\x0E-\\\\x1F]')) AS has_control_byte,
  countIf(position(url, unhex('EFBFBD'))>0 OR position(email, unhex('EFBFBD'))>0 OR position(password, unhex('EFBFBD'))>0) AS has_replacement_char
FROM ulp.credentials
SETTINGS max_execution_time = 300
" --format Vertical
echo ""

echo "═══ 3/5  Sample 15 rows that WILL be deleted (verify they're junk) ══"
$CH "
SELECT substring(url,1,45) AS url, substring(email,1,30) AS email, substring(password,1,40) AS password
FROM ulp.credentials
WHERE $IS_GARBAGE
LIMIT 15
SETTINGS max_execution_time = 120
" --format Vertical
echo ""

echo "═══ 4/5  Sample 10 PRESERVED rows (junk url + real email) ═══════"
$CH "
SELECT substring(url,1,40) AS url, email, substring(password,1,30) AS password
FROM ulp.credentials
WHERE $SALVAGEABLE
LIMIT 10
SETTINGS max_execution_time = 120
" --format Vertical
echo ""
echo "-- Top source_files among garbage rows --"
$CH "
SELECT source_file, count() AS garbage
FROM ulp.credentials
WHERE $IS_GARBAGE
GROUP BY source_file
ORDER BY garbage DESC
LIMIT 15
SETTINGS max_execution_time = 300
" --format PrettyCompact
echo ""

echo "═══ 5/5  Purge ══════════════════════════════════════════════════"
if [ "$PURGE" != "1" ]; then
  echo "Read-only. Review §3 (these get deleted) and §1 counts. To delete:"
  echo "  PURGE=1 bash scripts/diagnose-and-purge-garbage.sh"
else
  echo "Firing ALTER TABLE ulp.credentials DELETE WHERE <garbage> (async)..."
  if ! $CH "
  ALTER TABLE ulp.credentials DELETE WHERE $IS_GARBAGE
  SETTINGS mutations_sync = 0
  "; then
    echo "ERROR: DELETE mutation failed to submit."
    exit 1
  fi
  echo "Submitted. Monitor:"
  echo "  docker exec ulpsuite_clickhouse clickhouse-client --query \\"
  echo "    \"SELECT mutation_id, is_done, parts_to_do, latest_fail_reason"
  echo "     FROM system.mutations WHERE database='ulp' AND table='credentials'"
  echo "     AND NOT is_done\""
  echo "Then re-run this script (no PURGE) to watch garbage_rows fall to ~0."
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
