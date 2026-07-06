// instrumentation.ts
// Next.js 14+ way to setup global error handlers
// This file must be in the root directory (next to next.config.mjs and package.json)
// 
// NOTE: We also setup handlers in lib/error-handler.ts which auto-runs on import
// This provides double protection and ensures handlers are setup early

import { setupGlobalErrorHandlers } from "@/lib/error-handler"

/**
 * register() runs once at server startup (Node.js runtime only).
 *
 * Responsibilities:
 *  1. Global error handlers — suppress benign ECONNRESET/abort noise.
 *  2. ClickHouse schema migrations — run once before any HTTP request is
 *     served, so API routes never need to call runClickHouseMigrations().
 */
export async function register() {
  setupGlobalErrorHandlers()

  // Run ClickHouse DDL migrations at startup so every API route is
  // guaranteed to find a fully-initialised schema on its first request.
  // The guard inside runClickHouseMigrations() (migrationsDone flag) makes
  // re-calling safe, but this instrumentation hook ensures we only ever
  // pay the cost once — before any traffic arrives.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { runClickHouseMigrations } = await import('./lib/clickhouse-migrations')
      await runClickHouseMigrations()
    } catch (err) {
      // Non-fatal: individual API routes still call runClickHouseMigrations()
      // as a safety net (the upload route always does), so a startup failure
      // here will not break the app — it just defers the cost to first request.
      console.error('[instrumentation] ClickHouse migrations failed at startup:', err)
    }

    // Start scheduled monitor re-scanner (production only — prevents dev hot-reload duplicates)
    //
    // NOTE for anyone adding a new job here: this file is compiled into a
    // separate webpack chunk from API route handlers in production
    // (output: 'standalone'), so any module-scope state a job below shares
    // with a route (a getter a route calls, a queue a route also submits
    // to) must be anchored to globalThis, not a plain module-scope
    // let/const — see lib/upload-queue.ts / lib/inbox-watcher.ts for the
    // pattern, and docs/superpowers/specs/2026-07-05-inbox-status-globalthis-singleton-design.md
    // for the full root-cause writeup. Jobs with no route ever reading their
    // state (the crons below) don't need this.
    if (process.env.NODE_ENV === 'production') {
      try {
        const { startMonitorRescanCron } = await import('./lib/monitor-rescan-cron')
        startMonitorRescanCron()
      } catch (err) {
        console.error('[instrumentation] Monitor rescan cron failed to start:', err)
      }

      try {
        const { startInboxWatcher } = await import('./lib/inbox-watcher')
        startInboxWatcher()
      } catch (err) {
        console.error('[instrumentation] Inbox watcher failed to start:', err)
      }

      // Scheduled content-dedup (report-only unless CONTENT_DEDUP_APPLY=true).
      try {
        const { startDedupCron } = await import('./lib/dedup-cron')
        startDedupCron()
      } catch (err) {
        console.error('[instrumentation] Content-dedup cron failed to start:', err)
      }

      // Scheduled proj_imported_desc scoping (clears the recency projection from
      // partitions older than the recency window; harmless if it never runs).
      try {
        const { startProjectionScopeCron } = await import('./lib/projection-scope-cron')
        startProjectionScopeCron()
      } catch (err) {
        console.error('[instrumentation] Projection-scope cron failed to start:', err)
      }
    }
  }
}

