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
#   ./scripts/clickhouse-backup.sh space          # what a snapshot could cost in disk space; changes nothing
#   ./scripts/clickhouse-backup.sh full           # full backup → S3 (the local snapshot is deleted after upload)
#   ./scripts/clickhouse-backup.sh inc            # incremental backup → S3
#   ./scripts/clickhouse-backup.sh local          # local-only snapshot (this disk; no S3 needed) — see the warning below
#   ./scripts/clickhouse-backup.sh status         # newest backups, and exit 1 if the newest is stale
#   ./scripts/clickhouse-backup.sh list           # list local + remote backups
#   ./scripts/clickhouse-backup.sh verify         # DR drill: restore latest remote into ulp_verify, count, drop
#   ./scripts/clickhouse-backup.sh restore <name> # restore a backup OVER the live ulp db (guarded)
#   ./scripts/clickhouse-backup.sh version        # print clickhouse-backup version
#
# Environment:
#   BACKUP_TABLES        comma-separated db.table list to back up (default: the live ulp tables, see below)
#   BACKUP_FORCE=1       skip the disk-space guard (you have read `space` and accept the risk)
#   BACKUP_MAX_AGE_HOURS `status` exits 1 when the newest backup is older than this (default 72)
#   DISK_GUARD_MIN_FREE_BYTES / DISK_GUARD_MIN_FREE_RATIO   the same floor the app's disk guard uses
#                        (default: the stricter of 50 GiB and 15% of the disk)
#
# Requires S3_* set in .env (see .env.example) for full/inc/verify/restore. `local`, `space`, `status`
# and `list local` work without S3.
#
# Why tables are listed instead of `ulp.*`: the ulp database also holds the multi-hundred-GiB pre-dedup
# archive (credentials_predup_auto) and any dedup scratch tables. A wildcard would snapshot them too,
# pinning their parts (so dropping the archive later would free nothing while the snapshot exists) and
# trying to upload them.
#
# WARNING about local snapshots: they are hardlinks on the SAME disk. They cost nothing until a merge
# replaces the parts they point at; from then on the old parts stay on disk until the snapshot is
# deleted. A merge of one partition can therefore cost that partition's whole size. The `space` guard
# refuses to create a snapshot when free space minus the largest partition would fall below the floor.
# =====================================================

set -euo pipefail

# ─── compose invocation ──────────────────────────────────────────────────────
# `run --rm --no-deps`: one-shot, auto-removed, never (re)starts clickhouse/app.
COMPOSE="docker compose"
SVC="clickhouse-backup"
RUN=($COMPOSE run --rm --no-deps "$SVC")
CH=(docker exec -i ulpsuite_clickhouse clickhouse-client)
APP="ulpsuite_app"
STATUS_DIR="/app/data/backups"      # inside the app container (./data/backups on the host)

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${BLUE}[backup]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
fail() { echo -e "${RED}[error]${NC} $1"; }

GIB=$((1024 * 1024 * 1024))

# ─── which tables ────────────────────────────────────────────────────────────
default_tables() {
  "${CH[@]}" -q "SELECT arrayStringConcat(groupArray(concat('ulp.', name)), ',')
                 FROM system.tables
                 WHERE database = 'ulp' AND NOT match(name, '^(credentials_|zz_)')" 2>/dev/null || true
}
TABLES="${BACKUP_TABLES:-$(default_tables)}"
[ -z "$TABLES" ] && TABLES="ulp.credentials,ulp.sources,ulp.domains"

# `db.table,db.table` → `('db','table'),('db','table')` for a ClickHouse IN clause
table_tuples() {
  printf '%s' "$TABLES" | tr ',' '\n' | sed -E "s/'//g; s/^([^.]+)\.(.+)$/('\1','\2')/" | paste -sd, -
}

# ─── disk-space guard ────────────────────────────────────────────────────────
# Prints the numbers; returns 1 when a snapshot could take free space below the floor.
space_report() {
  local free total hazard floor
  read -r free total hazard < <("${CH[@]}" -q "
    SELECT
      (SELECT unreserved_space FROM system.disks WHERE name = 'default'),
      (SELECT total_space      FROM system.disks WHERE name = 'default'),
      (SELECT ifNull(max(b), 0) FROM (SELECT sum(bytes_on_disk) AS b FROM system.parts
         WHERE active AND (database, table) IN ($(table_tuples)) GROUP BY database, table, partition))
    FORMAT TSV")
  floor=$(awk -v t="$total" -v r="${DISK_GUARD_MIN_FREE_RATIO:-0.15}" -v b="${DISK_GUARD_MIN_FREE_BYTES:-$((50 * GIB))}" \
          'BEGIN { f = t * r; if (b + 0 > f) f = b + 0; printf "%.0f", f }')
  log "tables:                 $TABLES"
  log "free space:             $(awk -v v="$free" 'BEGIN{printf "%.1f GiB", v/1073741824}') of $(awk -v v="$total" 'BEGIN{printf "%.1f GiB", v/1073741824}')"
  log "largest partition:      $(awk -v v="$hazard" 'BEGIN{printf "%.1f GiB", v/1073741824}')  (what one merge could pin under a snapshot)"
  log "floor (guard):          $(awk -v v="$floor" 'BEGIN{printf "%.1f GiB", v/1073741824}')"
  log "free - partition:       $(awk -v f="$free" -v h="$hazard" 'BEGIN{printf "%.1f GiB", (f-h)/1073741824}')"
  if [ "$((free - hazard))" -lt "$floor" ]; then return 1; fi
  return 0
}

space_guard() {
  if [ "${BACKUP_FORCE:-0}" = "1" ]; then
    warn "BACKUP_FORCE=1 — skipping the disk-space guard."
    return 0
  fi
  if ! space_report; then
    fail "Refusing to snapshot: free space minus the largest partition would be below the floor."
    fail "A merge under a snapshot keeps the old parts on disk until the snapshot is deleted."
    fail "Free space first (the pre-dedup archive is the big one), or re-run with BACKUP_FORCE=1 if you accept the risk."
    exit 2
  fi
  ok "Disk-space guard passed."
}

# ─── status file the app's Ingest Health panel reads ─────────────────────────
# record <kind> <name> <offHost: true|false>. Written through the app container (the host user cannot
# write ./data). A failure here never fails the backup.
record() {
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"at":"%s","name":"%s","kind":"%s","offHost":%s}\n' "$ts" "$2" "$1" "$3" \
    | docker exec -i "$APP" sh -c "mkdir -p $STATUS_DIR && cat > $STATUS_DIR/clickhouse-last.json.tmp && mv $STATUS_DIR/clickhouse-last.json.tmp $STATUS_DIR/clickhouse-last.json" \
    || warn "Could not record this backup for the Ingest Health panel (the backup itself succeeded)."
}

cmd="${1:-help}"

case "$cmd" in
  space)
    if space_report; then ok "A local snapshot would pass the guard."; else warn "A local snapshot would be REFUSED by the guard."; fi
    ;;

  full)
    space_guard
    name="ulp-full-$(date -u +%Y%m%d-%H%M%S)"
    log "Creating FULL backup + uploading to S3 as: $name  (local copy is deleted after the upload)"
    "${RUN[@]}" create_remote --delete-source --resumable --tables "$TABLES" "$name"
    record full "$name" true
    ok "Full backup complete: $name"
    log "Remote retention is pruned automatically (30 remote)."
    ;;

  inc|incremental)
    space_guard
    # Use the most recent REMOTE backup as the diff base → only changed parts upload.
    base="$("${RUN[@]}" list remote 2>/dev/null | awk '{print $1}' | tail -n 1 || true)"
    name="ulp-inc-$(date -u +%Y%m%d-%H%M%S)"
    if [ -z "$base" ]; then
      warn "No remote backup found to diff from — falling back to a full backup."
      "${RUN[@]}" create_remote --delete-source --resumable --tables "$TABLES" "$name"
      record full "$name" true
    else
      log "Creating INCREMENTAL backup $name (diff from $base) + uploading to S3"
      "${RUN[@]}" create_remote --delete-source --resumable --diff-from-remote="$base" --tables "$TABLES" "$name"
      record inc "$name" true
    fi
    ok "Backup complete: $name"
    ;;

  local)
    space_guard
    name="ulp-local-$(date -u +%Y%m%d-%H%M%S)"
    warn "LOCAL snapshot: hardlinks on this disk. It protects against a bad migration or an accidental DROP,"
    warn "not against losing the disk; and it pins parts that merges replace until you delete it."
    "${RUN[@]}" create --tables "$TABLES" "$name"
    record local "$name" false
    ok "Local snapshot created: $name  (retention keeps the newest 2; delete earlier with: $0 list, then clickhouse-backup delete local <name>)"
    ;;

  status)
    max_h="${BACKUP_MAX_AGE_HOURS:-72}"
    log "Local backups:";  "${RUN[@]}" list local  2>/dev/null || warn "(could not list local backups)"
    log "Remote backups:"; "${RUN[@]}" list remote 2>/dev/null || warn "(no remote storage configured, or it could not be reached)"
    last="$(docker exec "$APP" cat "$STATUS_DIR/clickhouse-last.json" 2>/dev/null || true)"
    if [ -z "$last" ]; then
      fail "No ClickHouse backup has been recorded. Until one reaches S3, losing the disk loses every credential."
      exit 1
    fi
    at="$(printf '%s' "$last" | sed -E 's/.*"at":"([^"]+)".*/\1/')"
    off="$(printf '%s' "$last" | sed -E 's/.*"offHost":(true|false).*/\1/')"
    age_h=$(( ( $(date -u +%s) - $(date -u -d "$at" +%s) ) / 3600 ))
    log "Last recorded backup: $at (${age_h} h ago), off-host: $off"
    if [ "$age_h" -gt "$max_h" ]; then fail "Stale: older than ${max_h} h."; exit 1; fi
    if [ "$off" != "true" ]; then warn "The newest backup never left this disk."; exit 1; fi
    ok "Backups are fresh."
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
    "${CH[@]}" -q "SELECT 'ulp_verify.credentials' AS t, count() AS rows FROM ulp_verify.credentials"
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
    warn "docker-compose.yml pins the clickhouse-backup image; keep it pinned (avoid :latest drift)."
    ;;

  *)
    cat <<EOF
ULP Suite — ClickHouse backup wrapper

  ./scripts/clickhouse-backup.sh space           What a local snapshot could cost in disk space (changes nothing)
  ./scripts/clickhouse-backup.sh full            Full backup → S3 (local copy deleted after upload)
  ./scripts/clickhouse-backup.sh inc             Incremental backup (diff vs latest S3) → S3
  ./scripts/clickhouse-backup.sh local           Local-only snapshot (this disk; guarded by the space check)
  ./scripts/clickhouse-backup.sh status          Newest backups; exit 1 if none, stale or never off-host
  ./scripts/clickhouse-backup.sh list            List local + remote backups
  ./scripts/clickhouse-backup.sh verify          DR drill: restore latest S3 backup into ulp_verify, count rows
  ./scripts/clickhouse-backup.sh restore <name>  Restore a backup OVER the live ulp db (asks for confirmation)
  ./scripts/clickhouse-backup.sh version         Print clickhouse-backup version

First run, in order:  space  →  full  →  status  →  verify
Then schedule (host cron) — see docs/clickhouse-backup-runbook.md.
EOF
    ;;
esac
