#!/bin/sh
# Fix volume permissions so nextjs user can write uploads and SQLite data.
set -e
mkdir -p /app/uploads
mkdir -p /app/data
chown -R nextjs:nodejs /app/uploads 2>/dev/null || true
chown -R nextjs:nodejs /app/data 2>/dev/null || true
chmod -R 775 /app/uploads 2>/dev/null || true
chmod -R 775 /app/data 2>/dev/null || true
exec su nextjs -s /bin/sh -c "exec node server.js"
