#!/usr/bin/env bash
# =============================================================================
# ULP Suite — one-shot host hardening
#
# Brings a running ULP Suite host up to the hardened state:
#   • embedded ClickHouse Keeper + fsync durability (from the pulled configs)
#   • ulp.* converted in-place to ReplicatedMergeTree (block-level insert dedup)
#   • app rebuilt with the insert-dedup token + the ulp.sources re-upload guard
#
# RUN ON THE HOST, FROM THE REPO ROOT (~/ulp-suite), AFTER `git pull`:
#   bash scripts/apply-hardening.sh                       # dry run: assess + print plan
#   bash scripts/apply-hardening.sh --apply               # do it (restarts ClickHouse + app)
#   bash scripts/apply-hardening.sh --apply --purge-garbage   # also delete garbage-domain rows
#
# Safe + idempotent: takes a local backup before converting, verifies the row
# count is unchanged across the conversion (ABORTS on mismatch), and skips the
# conversion entirely if the tables are already Replicated. Off-host S3 backups
# are intentionally NOT automated here — they need your creds; use
# scripts/clickhouse-backup.sh once S3_* are set in .env.
# =============================================================================
set -euo pipefail

APPLY=0; PURGE=0
for a in "$@"; do
  case "$a" in
    --apply)         APPLY=1 ;;
    --purge-garbage) PURGE=1 ;;
    -h|--help)       grep '^#' "$0" | grep -v '^#!' | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a (try --help)"; exit 2 ;;
  esac
done

CH_CONTAINER="${CH_CONTAINER:-ulpsuite_clickhouse}"
APP_CONTAINER="${APP_CONTAINER:-ulpsuite_app}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${BLUE}[harden]${NC} $1"; }
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
die()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

ch()   { docker exec "$CH_CONTAINER" clickhouse-client -q "$1"; }
wait_ch() {
  for _ in $(seq 1 120); do
    docker exec "$CH_CONTAINER" clickhouse-client -q "SELECT 1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "ClickHouse did not become ready within 120s"
}

# ── Pre-flight ──────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found"
[ -f docker-compose.yml ] || die "run from the repo root (e.g. ~/ulp-suite)"
docker ps --format '{{.Names}}' | grep -qx "$CH_CONTAINER" || die "$CH_CONTAINER is not running"
[ -f docker/clickhouse/config/ulp-keeper.xml ] || die "ulp-keeper.xml missing — did you 'git pull' on main first?"
grep -q fsync_after_insert docker/clickhouse/config/ulp-performance.xml \
  || die "fsync config missing from ulp-performance.xml — did you 'git pull' on main first?"

# ── Phase 0: assess ─────────────────────────────────────────────────────────
log "Assessing current state…"
ENGINE=$(ch "SELECT engine FROM system.tables WHERE database='ulp' AND name='credentials'")
BASELINE=$(ch "SELECT count() FROM ulp.credentials")
DETACHED=$(ch "SELECT count() FROM system.detached_parts WHERE database='ulp'")
log "  credentials engine : $ENGINE"
log "  credentials rows   : $BASELINE   (integrity anchor)"
log "  detached parts     : $DETACHED"

NEED_CONVERT=0
[ "$ENGINE" = "ReplicatedMergeTree" ] || NEED_CONVERT=1

if [ "$APPLY" != "1" ]; then
  echo
  log "DRY RUN — planned actions (re-run with --apply to execute):"
  echo "   1. local backup (pre-hardening snapshot)"
  if [ "$NEED_CONVERT" = "1" ]; then
    echo "   2. stop app, restart ClickHouse → start Keeper + apply fsync"
    echo "   3. flag + restart → convert ulp.* to Replicated (verify row count == $BASELINE)"
  else
    echo "   2-3. already Replicated → Keeper/convert SKIPPED"
  fi
  echo "   4. rebuild app (insert-dedup token + re-upload guard)"
  if [ "$PURGE" = "1" ]; then echo "   5. delete garbage-domain rows"; else echo "   5. report garbage count (pass --purge-garbage to delete)"; fi
  exit 0
fi

# ── Phase 1: backup first (safety net) ──────────────────────────────────────
log "Creating a local backup before any change…"
docker compose run --rm --no-deps -e REMOTE_STORAGE=none clickhouse-backup \
  create --tables 'ulp.*' "pre-hardening-$(date -u +%Y%m%d-%H%M%S)" >/dev/null
ok "Local backup created (see: ./scripts/clickhouse-backup.sh list)."

APP_WAS_UP=0
docker ps --format '{{.Names}}' | grep -qx "$APP_CONTAINER" && APP_WAS_UP=1

if [ "$NEED_CONVERT" = "1" ]; then
  # ── Phase 2: Keeper + fsync (one restart, app quiesced) ──
  if [ "$APP_WAS_UP" = "1" ]; then log "Stopping app for the maintenance window…"; docker stop "$APP_CONTAINER" >/dev/null; fi
  BUSY=$(ch "SELECT (SELECT count() FROM system.processes WHERE query_kind='Insert')+(SELECT count() FROM system.merges)")
  [ "$BUSY" = "0" ] || warn "ClickHouse shows $BUSY active insert(s)/merge(s); proceeding (merges resume safely after restart)."
  log "Restarting ClickHouse to start embedded Keeper + apply fsync…"
  docker restart "$CH_CONTAINER" >/dev/null
  wait_ch
  if ! ch "SELECT name FROM system.zookeeper WHERE path='/'" 2>/dev/null | grep -q keeper; then
    die "Keeper did not start — NOT converting. Check docker logs $CH_CONTAINER and ulp-keeper.xml."
  fi
  [ "$(ch "SELECT value FROM system.merge_tree_settings WHERE name='fsync_after_insert'")" = "1" ] \
    || warn "fsync_after_insert is not active — verify ulp-performance.xml."
  ok "Keeper up; fsync active."

  # ── Phase 3: convert in-place (flag + restart), verify integrity ──
  log "Flagging ulp.* for conversion…"
  for t in credentials sources domains; do
    DP=$(ch "SELECT data_paths[1] FROM system.tables WHERE database='ulp' AND name='$t'")
    docker exec "$CH_CONTAINER" touch "${DP}convert_to_replicated"
  done
  log "Restarting ClickHouse to convert…"
  docker restart "$CH_CONTAINER" >/dev/null
  wait_ch
  NEW_ENGINE=$(ch "SELECT engine FROM system.tables WHERE database='ulp' AND name='credentials'")
  AFTER=$(ch "SELECT count() FROM ulp.credentials")
  [ "$NEW_ENGINE" = "ReplicatedMergeTree" ] || die "conversion did not take (engine=$NEW_ENGINE). Backup is available."
  [ "$AFTER" = "$BASELINE" ] || die "ROW COUNT MISMATCH ($BASELINE -> $AFTER). STOP — restore from the pre-hardening backup."
  ok "Converted to Replicated; row count intact ($AFTER)."
else
  warn "Tables already Replicated — skipping Keeper start + conversion."
fi

# ── Phase 4: rebuild app (dedup token + re-upload guard) ────────────────────
log "Rebuilding app (insert-dedup token + ulp.sources re-upload guard)…"
docker compose up -d --build app
for _ in $(seq 1 120); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null)" = "healthy" ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null)" = "healthy" ] \
  && ok "App rebuilt and healthy." || warn "App not reporting healthy yet — check: docker compose logs app"

# ── Phase 5: garbage-domain rows ────────────────────────────────────────────
PRED="match(domain,'[[:cntrl:]]') OR match(domain,'^([0-9A-Za-z] ){3,}') OR position(domain,char(0))>0"
GARBAGE=$(ch "SELECT count() FROM ulp.credentials WHERE $PRED")
log "Garbage-domain rows: $GARBAGE"
if [ "$PURGE" = "1" ] && [ "$GARBAGE" != "0" ]; then
  log "Deleting $GARBAGE garbage rows (async mutation; polling to completion)…"
  ch "ALTER TABLE ulp.credentials DELETE WHERE $PRED"
  for _ in $(seq 1 600); do
    [ "$(ch "SELECT count() FROM system.mutations WHERE database='ulp' AND table='credentials' AND is_done=0")" = "0" ] && break
    sleep 3
  done
  ok "Garbage purge complete; remaining: $(ch "SELECT count() FROM ulp.credentials WHERE $PRED")"
elif [ "$GARBAGE" != "0" ]; then
  warn "Re-run with --purge-garbage to delete them (rewrites the part; safe — domain-garbage only)."
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo
ok "Hardening complete on $CH_CONTAINER."
log "Remaining manual step — OFF-HOST backups (needs your S3 creds):"
log "  add S3_ACCESS_KEY/SECRET_KEY/BUCKET/ENDPOINT/REGION to .env, then:"
log "  ./scripts/clickhouse-backup.sh full && ./scripts/clickhouse-backup.sh verify"
