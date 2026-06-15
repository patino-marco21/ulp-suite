#!/bin/bash
# =====================================================
# ULP Suite — ClickHouse backup wrapper (P0 disaster recovery)
#
# Thin convenience layer over the `clickhouse-backup` compose service.
# Runs it as a one-shot container (profile: backup) that shares the ClickHouse
# data volume and reaches the server at clickhouse:9000 over the internal network.
# Nothing here starts or restarts your clickhouse/app services.
#
# Usage (run from the repo root, e.g. ~/ulp-suite):
#   ./scripts/clickhouse-backup.sh full           # full backup → local + S3
#   ./scripts/clickhouse-backup.sh inc            # incremental backup → local + S3
#   ./scripts/clickhouse-backup.sh list           # list local + remote backups
#   ./scripts/clickhouse-backup.sh verify         # DR drill: restore latest remote into ulp_verify, count, drop
#   ./scripts/clickhouse-backup.sh restore <name> # restore a backup OVER the live ulp db (guarded)
#   ./scripts/clickhouse-backup.sh version        # print clickhouse-backup version (pin the image after this)
#
# Requires S3_* set in .env (see .env.example). Local-only ops (create/list local)
# work even without S3 configured.
# =====================================================

set -euo pipefail

# ─── compose invocation ──────────────────────────────────────────────────────
# `run --rm --no-deps`: one-shot, auto-removed, never (re)starts clickhouse/app.
COMPOSE="docker compose"
SVC="clickhouse-backup"
RUN=($COMPOSE run --rm --no-deps "$SVC")

TABLES="ulp.*"            # back up the ulp database only (system tables are skipped by default)

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${BLUE}[backup]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
fail() { echo -e "${RED}[error]${NC} $1"; }

cmd="${1:-help}"

case "$cmd" in
  full)
    name="ulp-full-$(date -u +%Y%m%d-%H%M%S)"
    log "Creating FULL backup + uploading to S3 as: $name"
    "${RUN[@]}" create_remote --tables "$TABLES" "$name"
    ok "Full backup complete: $name"
    log "Local + remote retention is pruned automatically (7 local / 30 remote)."
    ;;

  inc|incremental)
    # Use the most recent REMOTE backup as the diff base → only changed parts upload.
    base="$("${RUN[@]}" list remote 2>/dev/null | awk '{print $1}' | tail -n 1 || true)"
    name="ulp-inc-$(date -u +%Y%m%d-%H%M%S)"
    if [ -z "$base" ]; then
      warn "No remote backup found to diff from — falling back to a full backup."
      "${RUN[@]}" create_remote --tables "$TABLES" "$name"
    else
      log "Creating INCREMENTAL backup $name (diff from $base) + uploading to S3"
      "${RUN[@]}" create_remote --diff-from-remote="$base" --tables "$TABLES" "$name"
    fi
    ok "Incremental backup complete: $name"
    ;;

  list)
    log "Local backups:";  "${RUN[@]}" list local  || true
    log "Remote backups:"; "${RUN[@]}" list remote || true
    ;;

  verify)
    # Disaster-recovery drill: prove the latest REMOTE backup actually restores.
    # Restores into a throwaway db (ulp_verify) so the live `ulp` db is untouched.
    base="$("${RUN[@]}" list remote 2>/dev/null | awk '{print $1}' | tail -n 1 || true)"
    [ -z "$base" ] && { fail "No remote backup to verify."; exit 1; }
    log "DR drill: restoring $base into ulp_verify (live ulp db is NOT touched)…"
    "${RUN[@]}" restore_remote --rm --restore-database-mapping ulp:ulp_verify --tables "$TABLES" "$base"
    log "Counting restored rows…"
    docker exec ulpsuite_clickhouse clickhouse-client -q \
      "SELECT 'ulp_verify.credentials' AS t, count() AS rows FROM ulp_verify.credentials"
    warn "Drill table left as ulp_verify for your inspection."
    warn "Drop it when satisfied:  docker exec ulpsuite_clickhouse clickhouse-client -q 'DROP DATABASE ulp_verify'"
    ok "Restore drill completed — your backup is restorable."
    ;;

  restore)
    name="${2:-}"
    [ -z "$name" ] && { fail "Usage: $0 restore <backup-name>   (see: $0 list)"; exit 1; }
    fail "This restores '$name' OVER the live ulp database. Existing data may be replaced."
    read -r -p "Type the backup name to confirm: " confirm
    [ "$confirm" != "$name" ] && { warn "Aborted."; exit 1; }
    log "Restoring $name (download if needed)…"
    "${RUN[@]}" restore_remote --rm "$name"
    ok "Restore complete. Verify: docker exec ulpsuite_clickhouse clickhouse-client -q 'SELECT count() FROM ulp.credentials'"
    ;;

  version)
    "${RUN[@]}" --version || "${RUN[@]}" version
    warn "Pin docker-compose.yml's clickhouse-backup image to THIS version (avoid :latest drift)."
    ;;

  *)
    cat <<EOF
ULP Suite — ClickHouse backup wrapper

  ./scripts/clickhouse-backup.sh full            Full backup → local snapshot + S3
  ./scripts/clickhouse-backup.sh inc             Incremental backup (diff vs latest S3) → local + S3
  ./scripts/clickhouse-backup.sh list            List local + remote backups
  ./scripts/clickhouse-backup.sh verify          DR drill: restore latest S3 backup into ulp_verify, count rows
  ./scripts/clickhouse-backup.sh restore <name>  Restore a backup OVER the live ulp db (asks for confirmation)
  ./scripts/clickhouse-backup.sh version         Print clickhouse-backup version

First run, in order:  version  →  full  →  list  →  verify
Then schedule (host cron) — see docs/clickhouse-backup-runbook.md.
EOF
    ;;
esac
