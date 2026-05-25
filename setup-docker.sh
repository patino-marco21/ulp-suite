#!/bin/bash

# =====================================================
# ULP Credential Searcher - Docker Setup Script
# Verifies MySQL and ClickHouse are ready.
# ClickHouse ULP tables are created via initdb scripts.
# =====================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ️  [SETUP]${NC} $1"; }
log_success() { echo -e "${GREEN}✅ [SETUP]${NC} $1"; }
log_error()   { echo -e "${RED}❌ [SETUP]${NC} $1"; }

DB_HOST="mysql"
CH_HOST="clickhouse"

REQUIRED_VARS=(
    "MYSQL_ROOT_PASSWORD"
    "MYSQL_DATABASE"
    "MYSQL_USER"
    "MYSQL_PASSWORD"
    "CLICKHOUSE_USER"
    "CLICKHOUSE_PASSWORD"
)

MISSING_VARS=()
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    log_error "Missing required environment variables: ${MISSING_VARS[*]}"
    exit 1
fi

log_success "All required environment variables are set"

# ----- Wait for MySQL -----
log_info "Waiting for MySQL..."
MAX_RETRIES=60
count=0
while [ $count -lt $MAX_RETRIES ]; do
    if mysql -h "$DB_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1" >/dev/null 2>&1; then
        log_success "MySQL is ready"
        break
    fi
    count=$((count + 1))
    echo -n "."
    sleep 2
done
[ $count -eq $MAX_RETRIES ] && { log_error "MySQL timeout"; exit 1; }

# ----- Wait for ClickHouse -----
log_info "Waiting for ClickHouse..."
count=0
while [ $count -lt $MAX_RETRIES ]; do
    if curl -s "http://$CH_HOST:8123/ping" | grep -q "Ok"; then
        log_success "ClickHouse is ready"
        break
    fi
    count=$((count + 1))
    echo -n "."
    sleep 2
done
[ $count -eq $MAX_RETRIES ] && { log_error "ClickHouse timeout"; exit 1; }

# ----- Verify ULP tables exist -----
log_info "Verifying ULP tables..."
RESPONSE=$(curl -s -u "${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}" \
    "http://$CH_HOST:8123/" \
    -d "SELECT count() FROM ulp.credentials")

if echo "$RESPONSE" | grep -q "Exception"; then
    log_error "ULP tables not found. Check ClickHouse initdb logs: docker compose logs clickhouse"
    log_error "Response: $RESPONSE"
    exit 1
fi

log_success "ULP tables verified"

echo ""
log_success "🎉 Setup complete. Stack is ready."
echo ""
echo "  ✅ MySQL: ready (app metadata)"
echo "  ✅ ClickHouse: ready (ULP credential data)"
echo ""
echo "  Upload credentials at: http://localhost:3000/upload"
echo "  Search credentials at: http://localhost:3000"
echo ""
