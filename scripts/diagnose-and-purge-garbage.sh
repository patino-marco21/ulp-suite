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
#   (c) the email contains internal whitespace, or has an @-domain with no
#       letter at all (e.g. "x@#", "x@123") -- no real email matches either.
#   (d) email or url contains the latin1-mojibake signature of a multibyte
#       UTF-8 character (real UTF-8 decoded as latin1 by the parser) -- NEVER
#       checked on password, the one field that legitimately carries
#       non-ASCII content. See lib/ulp-garbage.ts (shared with the parser).
#   (e) email or password differs from its own trimBoth() -- a leftover
#       leading/trailing separator character (tab/LF/CR/space), not content.
#       Checked on password too (unlike (c)/(d)) because this is structural,
#       not content -- see lib/ulp-garbage.ts's hasEdgeWhitespace.
#   (f) password is an exact-match export/serialization placeholder (null,
#       undefined, unknown/[unknown], n/a) -- mirrors SENTINEL_PASSWORDS in
#       lib/ulp-parser.ts; keep the two lists in sync. Deliberately excludes
#       "password" and "test" -- common real (if weak) user-chosen passwords,
#       not extraction-failure artifacts (2026-07-03 finding).
#   (g) email contains 2+ "@" signs -- a real address has exactly one; two or
#       more means two records got concatenated with no separator (e.g.
#       "user@gmail.comother@yahoo.de"). See lib/ulp-garbage.ts's
#       hasGarbageIdentity, checked BEFORE the letter-less-domain rule in (c)
#       since that rule only inspects text after the LAST "@" and would
#       otherwise see a normal trailing domain and miss the merge.
#   (h) email or url contains "ic3l0gs" or "karmacloud" -- a seller
#       watermark/branding string found repeated 3-4x inside single rows in
#       the 2026-07-03 ingest (a known combo-list practice: sellers inject a
#       marker to brand/poison copies of their list). Dataset-specific, so
#       intentionally NOT in lib/ulp-garbage.ts / the parser -- this is a
#       one-off backlog cleanup, not a permanent structural rule. ~89% of
#       these rows are already caught by (g); this adds the remainder where
#       the watermark landed somewhere that didn't produce a 2nd "@".
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
# PURGE cancels any failed prior attempt of this exact purge first (a heavyweight
# ALTER TABLE ... DELETE version of this same predicate was found stuck retrying
# and failing with MEMORY_LIMIT_EXCEEDED for ~20h on 2026-06-27/28 -- the same
# wall scripts/purge-existing-t3.sh already hit and fixed for T3), then fires a
# bounded-memory lightweight DELETE FROM (max_threads=2). It does NOT block --
# re-run the default (no PURGE) afterward to watch the count fall.
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
  OR match(trimBoth(email), '\\s')
  OR (length(email) - length(replaceAll(email, '@', ''))) >= 2
  OR (position(email,'@') > 0 AND NOT match(email_domain, '[a-z]'))
  OR match(email, '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
  OR match(url,   '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
  OR email    != trimBoth(email)
  OR password != trimBoth(password)
  OR lower(password) IN ('null','undefined','unknown','[unknown]','n/a')
  OR email ILIKE '%ic3l0gs%' OR email ILIKE '%karmacloud%'
  OR url   ILIKE '%ic3l0gs%' OR url   ILIKE '%karmacloud%'
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
  countIf(position(url, unhex('EFBFBD'))>0 OR position(email, unhex('EFBFBD'))>0 OR position(password, unhex('EFBFBD'))>0) AS has_replacement_char,
  countIf(match(trimBoth(email), '\\\\s')) AS has_whitespace_identity,
  countIf(position(email,'@')>0 AND NOT match(email_domain, '[a-z]')) AS has_letterless_domain,
  countIf(match(email, '[\\\\x{C2}-\\\\x{EF}][\\\\x{80}-\\\\x{BF}]') OR match(url, '[\\\\x{C2}-\\\\x{EF}][\\\\x{80}-\\\\x{BF}]')) AS has_mojibake_signature
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
  # The garbage predicate is a large multi-line regex expression -- too fragile to
  # match a failed mutation by full command-string equality (unlike T3's simple
  # `country_tier = 'T3'`, see scripts/purge-existing-t3.sh). Match by a short,
  # distinctive substring instead, mirroring lib/content-dedup.ts's
  # MUTATION_MARKER + `command LIKE` pattern.
  #
  # MUST contain no quote characters: it gets embedded as '%${MUTATION_MARKER}%'
  # below. A first version used "unhex('EFBFBD')" -- its own embedded single
  # quotes closed that outer string literal early, producing a SQL syntax error
  # in production (confirmed by reproducing the exact interpolation: the result
  # `'%unhex('EFBFBD')%'` parses as the string `%unhex(`, then the bare token
  # `EFBFBD`, then `)%'` -- not a valid LIKE pattern). Bare EFBFBD (the hex
  # appearing inside all 3 of IS_GARBAGE's unhex('EFBFBD') calls) is just as
  # distinctive and has no quoting hazard.
  MUTATION_MARKER="EFBFBD"

  echo "Cancelling any failed prior garbage-purge mutations..."
  failed_ids="$($CH "
  SELECT mutation_id FROM system.mutations
  WHERE database = 'ulp' AND table = 'credentials'
    AND is_done = 0 AND latest_fail_reason != ''
    AND command LIKE '%${MUTATION_MARKER}%'
  FORMAT TSVRaw
  ")"
  while IFS= read -r mutation_id; do
    [ -z "$mutation_id" ] && continue
    echo "  Cancelling failed garbage-purge mutation: $mutation_id"
    $CH "
    KILL MUTATION WHERE database = 'ulp' AND table = 'credentials'
      AND mutation_id = '$mutation_id' AND is_done = 0
      AND command LIKE '%${MUTATION_MARKER}%'
    SYNC
    "
  done <<< "$failed_ids"

  active="$($CH "
  SELECT count() FROM system.mutations
  WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0
  FORMAT TSVRaw
  ")"
  if [ "$active" != "0" ]; then
    echo "ERROR: $active credential-table mutation(s) are already active; wait before purging." >&2
    exit 1
  fi

  echo "Submitting bounded-memory lightweight garbage deletion..."
  if ! $CH "
  DELETE FROM ulp.credentials WHERE $IS_GARBAGE
  SETTINGS lightweight_deletes_sync = 2,
           max_threads = 2,
           max_execution_time = 0
  "; then
    echo "ERROR: lightweight DELETE failed to submit."
    exit 1
  fi

  remaining="$($CH "SELECT countIf($IS_GARBAGE) FROM ulp.credentials FORMAT TSVRaw")"
  echo "Purge complete; remaining garbage rows: $remaining."
  echo "Physical disk is reclaimed gradually by normal background merges."
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
