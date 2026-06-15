#!/bin/bash
# =============================================================================
# diagnose-reject-classes.sh
#
# READ-ONLY. Counts how many existing rows in ulp.credentials match each class
# the *current* parser now rejects or recovers (the 2026-06 hardening — see
# docs/superpowers/specs/2026-06-15-parser-reject-taxonomy.md). Use this to size
# the cleanup before re-importing source files through the fixed parser.
#
# These predicates MIRROR lib/ulp-parser.ts (PLACEHOLDER_LOGINS,
# SENTINEL_PASSWORDS, hasJunkMarker, the URL-path-@ and port-leak rules). They
# are an ESTIMATE — the parser is the source of truth, and the SQL can drift if
# the sets change. Nothing is deleted; this only SELECTs counts.
#
# Usage (from the project dir, with the clickhouse container up):
#   bash scripts/diagnose-reject-classes.sh
# =============================================================================

set -uo pipefail
CH="docker exec ulpsuite_clickhouse clickhouse-client --query"

read -r -d '' SQL <<'EOF'
SELECT
  count() AS total_rows,

  -- Rejected: sentinel passwords (no real password could be extracted)
  countIf(
    lower(trim(password)) IN
      ('[not_saved]','not_saved','*none*','none','[fail]','decryptionfailed.',
       'old or unknown version.','[empty]','*empty*','[fetch_error]')
    OR match(password, '^\*+$')
  ) AS sentinel_passwords,

  -- Rejected: placeholder logins (not a real identity)
  countIf(
    lower(trim(email)) IN
      ('password','n/a','na','none','null','undefined','[not_saved]','not_saved',
       'unknown','[unknown]','{mail}','{email}','false','missing-user','pass',
       'https','http')
  ) AS placeholder_logins,

  -- Rejected: token / decryption blobs in login or password
  countIf(
    position(email,'gmail_ps=')>0    OR position(password,'gmail_ps=')>0
    OR position(email,'gmail=')>0    OR position(password,'gmail=')>0
    OR position(email,'==@com.')>0   OR position(password,'==@com.')>0
    OR position(email,'[Wrong padding]')>0 OR position(password,'[Wrong padding]')>0
  ) AS token_blobs,

  -- Rejected: double-encoded mojibake (latin1 view of EF BF BD, stored as C3AF C2BF C2BD)
  countIf(
    position(url, unhex('C3AFC2BFC2BD'))>0
    OR position(email, unhex('C3AFC2BFC2BD'))>0
    OR position(password, unhex('C3AFC2BFC2BD'))>0
  ) AS double_mojibake,

  -- Rejected (2-field) / realigned (3-field): URL path with '@' in the login slot
  countIf(
    position(email,'@')>0 AND position(email,'/')>0
    AND position(email,'/') < position(email,'@')
  ) AS url_path_at_login,

  -- Recoverable on re-import: scheme-less host:port/path:login:pass (port leaked into login)
  countIf(match(email, '^[0-9]+/')) AS port_path_leak

FROM ulp.credentials
SETTINGS max_execution_time = 300
EOF

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ULP Suite — reject/recover class counts (READ-ONLY)        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "Mirrors lib/ulp-parser.ts as of 2026-06-15. Estimate, not authoritative."
echo ""
$CH "$SQL" --format Vertical
echo ""
echo "Rejected classes are dropped on (re-)import; port_path_leak is RECOVERED"
echo "(host:port folded into the URL, real login:pass extracted). To act on the"
echo "existing table, re-import the affected source files through the fixed parser."
echo "═══════════════════════════════════════════════════════════════"
