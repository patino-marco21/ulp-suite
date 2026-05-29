#!/bin/sh
# Fix volume permissions so nextjs user can write uploads, SQLite data, and inbox dirs.
set -e
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
exec su nextjs -s /bin/sh -c "exec node server.js"
