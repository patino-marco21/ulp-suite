#!/bin/bash
# =====================================================
# ULP Bulk Import Script
# Imports .txt files containing url:login:password data
# directly into ClickHouse via the app's upload API.
#
# Usage:
#   ./scripts/import-ulp.sh /path/to/ulp/files/
#
# Options:
#   INPUT_DIR       Directory containing .txt files (default: ./ulp-files)
#   APP_URL         App base URL (default: http://localhost:3000)
#   AUTH_TOKEN      JWT token or API key for authentication
#   CLICKHOUSE_HOST ClickHouse HTTP host (default: localhost)
#   CLICKHOUSE_PORT ClickHouse HTTP port (default: 8123)
#   CLICKHOUSE_USER ClickHouse user (default: default)
#   CLICKHOUSE_PASS ClickHouse password
#   CLICKHOUSE_DB   Target database (default: ulp)
# =====================================================

set -euo pipefail

INPUT_DIR="${1:-./ulp-files}"
APP_URL="${APP_URL:-http://localhost:3000}"
CH_HOST="${CLICKHOUSE_HOST:-localhost}"
CH_PORT="${CLICKHOUSE_PORT:-8123}"
CH_USER="${CLICKHOUSE_USER:-default}"
CH_PASS="${CLICKHOUSE_PASS:-}"
CH_DB="${CLICKHOUSE_DB:-ulp}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${BLUE}[import]${NC} $1"; }
ok()    { echo -e "${GREEN}[ok]${NC} $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; }

if [ ! -d "$INPUT_DIR" ]; then
    fail "Directory not found: $INPUT_DIR"
    exit 1
fi

TXT_FILES=("$INPUT_DIR"/*.txt)
if [ ! -f "${TXT_FILES[0]}" ]; then
    warn "No .txt files found in $INPUT_DIR"
    exit 0
fi

log "Importing from: $INPUT_DIR"
log "ClickHouse: http://$CH_HOST:$CH_PORT/$CH_DB"

TOTAL_IMPORTED=0
TOTAL_FAILED=0

for file in "$INPUT_DIR"/*.txt; do
    [ -f "$file" ] || continue
    filename=$(basename "$file")
    log "Processing: $filename"

    # Count lines for progress feedback
    line_count=$(wc -l < "$file" 2>/dev/null || echo "?")
    log "  Lines: $line_count"

    # Parse and insert via ClickHouse HTTP interface.
    # awk parses url:login:password (colon or semicolon separated).
    # Extracts domain from URL as a best-effort strip of protocol/path.
    RESPONSE=$(awk '
        BEGIN { FS="[:;]"; OFS="\t" }
        /^#/ { next }
        /^\/\// { next }
        NF < 3 { next }
        NF == 3 {
            url=$1; email=$2; pass=$3
        }
        NF > 3 && ($1 ~ /^https?$/) {
            # URL contains colons: https://host:port/path:email:pass
            url=$1":"$2":"$3; email=$4; pass=$5
            if (NF < 5) next
        }
        {
            domain=url
            gsub(/^https?:\/\//, "", domain)
            gsub(/^www\./, "", domain)
            sub(/\/.*/, "", domain)
            sub(/:.*/, "", domain)
            print url, email, pass, domain, "'"$filename"'"
        }
    ' "$file" | curl -s \
        -u "${CH_USER}:${CH_PASS}" \
        "http://$CH_HOST:$CH_PORT/?query=INSERT+INTO+${CH_DB}.credentials+(url,email,password,domain,source_file)+FORMAT+TabSeparated" \
        --data-binary @-)

    if [ -n "$RESPONSE" ] && echo "$RESPONSE" | grep -q "Exception"; then
        fail "  Failed: $RESPONSE"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    else
        # Record in sources table
        curl -s \
            -u "${CH_USER}:${CH_PASS}" \
            "http://$CH_HOST:$CH_PORT/?query=INSERT+INTO+${CH_DB}.sources+(filename,line_count)+VALUES+('$(echo "$filename" | sed "s/'/\\\\'/g")',${line_count})" \
            > /dev/null
        ok "  Imported: $filename"
        TOTAL_IMPORTED=$((TOTAL_IMPORTED + 1))
    fi
done

echo ""
ok "Done. Imported: $TOTAL_IMPORTED files. Failed: $TOTAL_FAILED files."
echo ""
log "Verify with:"
echo "  curl -u $CH_USER:\$CH_PASS http://$CH_HOST:$CH_PORT/ -d 'SELECT count() FROM ${CH_DB}.credentials'"
