# ─── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# Build tools for native addons (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# --mount=type=cache persists the npm download cache on the Docker host between
# builds.  When package.json hasn't changed, this layer is cached anyway; when
# it has changed, re-download is 3–5× faster because tarballs are already local.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Copy node_modules FIRST so this layer is cached independently of source changes.
# When only source files change (not package.json), Docker reuses this layer and
# skips the 11-second COPY — only COPY . . and npm run build need to rerun.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# --mount=type=cache persists the Next.js webpack/SWC compilation cache on the
# host between builds.  Even when Docker's own layer cache is cold (fresh
# machine, base image update), Next.js reuses its own cache and only recompiles
# changed modules.  Turns full 134s rebuilds into ~35-45s for typical changes.
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# ─── Stage 3: Production runner ───────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --gid 1001 nodejs && adduser --uid 1001 --ingroup nodejs --disabled-password --gecos "" nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Next.js standalone output-tracing omits several internal subdirectories
# (next/dist/lib/, next/dist/shared/, etc.) that are required at runtime.
# Copy the entire next/dist from the builder to fill all gaps reliably.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/next/dist ./node_modules/next/dist

# NOTE: The previous "RUN chown -R nextjs:nodejs /app" has been removed.
# Every COPY above already carries --chown=nextjs:nodejs, so the recursive chown
# was completely redundant.  It was the single slowest step at ~58 seconds and
# also bloated the final image by duplicating the modified layer.

USER root
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/auth/check-users', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "server.js"]
