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
    if (process.env.NODE_ENV === 'production') {
      console.warn('[instrumentation] DIAGNOSTIC: entered production cron-registration block')
      try {
        console.warn('[instrumentation] DIAGNOSTIC: about to import monitor-rescan-cron')
        const { startMonitorRescanCron } = await import('./lib/monitor-rescan-cron')
        console.warn('[instrumentation] DIAGNOSTIC: imported monitor-rescan-cron, calling it')
        startMonitorRescanCron()
        console.warn('[instrumentation] DIAGNOSTIC: called startMonitorRescanCron')
      } catch (err) {
        console.error('[instrumentation] Monitor rescan cron failed to start:', err)
      }

      try {
        console.warn('[instrumentation] DIAGNOSTIC: about to import inbox-watcher')
        const { startInboxWatcher } = await import('./lib/inbox-watcher')
        console.warn('[instrumentation] DIAGNOSTIC: imported inbox-watcher, calling it')
        startInboxWatcher()
        console.warn('[instrumentation] DIAGNOSTIC: called startInboxWatcher')
      } catch (err) {
        console.error('[instrumentation] Inbox watcher failed to start:', err)
      }

      // Scheduled content-dedup (report-only unless CONTENT_DEDUP_APPLY=true).
      try {
        console.warn('[instrumentation] DIAGNOSTIC: about to import dedup-cron')
        const { startDedupCron } = await import('./lib/dedup-cron')
        console.warn('[instrumentation] DIAGNOSTIC: imported dedup-cron, calling it')
        startDedupCron()
        console.warn('[instrumentation] DIAGNOSTIC: called startDedupCron')
      } catch (err) {
        console.error('[instrumentation] Content-dedup cron failed to start:', err)
      }

      // Scheduled proj_imported_desc scoping (clears the recency projection from
      // partitions older than the recency window; harmless if it never runs).
      try {
        console.warn('[instrumentation] DIAGNOSTIC: about to import projection-scope-cron')
        const { startProjectionScopeCron } = await import('./lib/projection-scope-cron')
        console.warn('[instrumentation] DIAGNOSTIC: imported projection-scope-cron, calling it')
        startProjectionScopeCron()
        console.warn('[instrumentation] DIAGNOSTIC: called startProjectionScopeCron')
      } catch (err) {
        console.error('[instrumentation] Projection-scope cron failed to start:', err)
      }
      console.warn('[instrumentation] DIAGNOSTIC: reached end of cron-registration block')
    }
  }
}

