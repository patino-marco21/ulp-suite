#!/bin/sh
# Fix volume permissions so nextjs user can write uploads, SQLite data, and inbox dirs.
set -e

echo "[ulp-suite] container starting at $(date -u 2>/dev/null || date)"
echo "[ulp-suite] node $(/usr/local/bin/node --version 2>&1)"

# Crash loudly if the standalone build is missing — avoids silent "module not found"
if [ ! -f /app/server.js ]; then
  echo "[ulp-suite] FATAL: /app/server.js not found — Docker image may be corrupt, rebuild with: docker compose build --no-cache app"
  exit 1
fi

# Warn immediately if better-sqlite3 native addon is absent — the app will crash
# on the first SQLite access (users table read, login, etc.) without this.
if [ ! -d /app/node_modules/better-sqlite3 ]; then
  echo "[ulp-suite] WARNING: /app/node_modules/better-sqlite3 not found — rebuild the image"
else
  SQLITE_NODE=$(find /app/node_modules/better-sqlite3/build/Release -name "*.node" 2>/dev/null | head -1)
  if [ -z "$SQLITE_NODE" ]; then
    echo "[ulp-suite] WARNING: better-sqlite3 directory exists but compiled .node binary is missing"
  else
    echo "[ulp-suite] better-sqlite3 binary: $SQLITE_NODE"
  fi
fi

mkdir -p /app/uploads
mkdir -p /app/data
mkdir -p /app/inbox
mkdir -p /app/inbox/done
mkdir -p /app/inbox/failed
chown -R nextjs:nodejs /app/uploads  2>/dev/null || true
chown -R nextjs:nodejs /app/data     2>/dev/null || true
chown -R nextjs:nodejs /app/inbox    2>/dev/null || true
chmod -R 775 /app/uploads 2>/dev/null || true
chmod -R 775 /app/data    2>/dev/null || true
chmod -R 775 /app/inbox   2>/dev/null || true

echo "[ulp-suite] launching Next.js as nextjs user..."
# Use the absolute path to node so the exec survives any PATH stripping by su.
# su without --login preserves most env vars on Debian util-linux su, but the
# PATH can still be reset to /usr/bin:/bin — /usr/local/bin (where node lives)
# would then be missing.  Full path sidesteps this entirely.
exec su nextjs -s /bin/sh -c "exec /usr/local/bin/node /app/server.js"
