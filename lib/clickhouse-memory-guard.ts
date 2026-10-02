/**
 * Memory-aware backpressure for the ingest pipeline.
 *
 * Polls ClickHouse's own memory tracker (system.metrics.MemoryTracking)
 * against its configured ceiling (system.server_settings.max_server_memory_usage)
 * -- the same two numbers OvercommitTracker itself compares before killing a
 * query -- so imports can pace themselves ahead of a kill instead of reacting
 * to one after the fact.
 *
 * See docs/superpowers/specs/2026-07-20-ingest-memory-backpressure-design.md.
 */

import { getClient } from '@/lib/clickhouse'

export interface MemoryPressure {
  usedBytes:    number
  ceilingBytes: number
  ratio:        number
}

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const DEFAULT_THRESHOLD_RATIO  = parseEnvNumber(process.env.MEMORY_GUARD_THRESHOLD_RATIO, 0.75)
const DEFAULT_MAX_WAIT_MS      = parseEnvNumber(process.env.MEMORY_GUARD_MAX_WAIT_MS, 10 * 60 * 1_000)
const DEFAULT_POLL_INTERVAL_MS = 5_000

/** Live snapshot of ClickHouse's own memory tracker vs. its configured ceiling. */
export async function checkMemoryPressure(signal: AbortSignal): Promise<MemoryPressure> {
  const res = await getClient().query({
    query: `
      SELECT
        (SELECT value FROM system.metrics WHERE metric = 'MemoryTracking')                AS used,
        (SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage') AS ceiling
    `,
    format:       'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: {
      use_query_cache: 0,
    },
  })
  const rows = await res.json() as Array<{ used: string | number; ceiling: string | number }>
  const usedBytes    = Number(rows[0]?.used ?? 0)
  const ceilingBytes = Number(rows[0]?.ceiling ?? 0)
  const ratio         = ceilingBytes > 0 ? usedBytes / ceilingBytes : 0
  return { usedBytes, ceilingBytes, ratio }
}

/**
 * Polls checkMemoryPressure until the ratio drops below threshold, or
 * maxWaitMs elapses -- whichever comes first. Fail-open: any error from
 * checkMemoryPressure, or exceeding maxWaitMs while still above threshold,
 * resolves immediately rather than throwing or hanging. This is a soft
 * pacing layer, not a correctness dependency -- the existing
 * withClickHouseRetry safety net (lib/clickhouse-retry.ts) still covers a
 * batch that fails despite backpressure.
 *
 * Reports each poll through opts.onPoll (a waiting import is not a wedged one,
 * see lib/import-runner.ts) and throws the signal's reason once the signal is
 * aborted, so a cancelled import stops waiting instead of polling on.
 */
export async function waitForHeadroom(
  signal: AbortSignal,
  opts: { thresholdRatio?: number; maxWaitMs?: number; pollIntervalMs?: number; onPoll?: () => void } = {},
): Promise<void> {
  const thresholdRatio = opts.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const maxWaitMs      = opts.maxWaitMs      ?? DEFAULT_MAX_WAIT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const deadline = Date.now() + maxWaitMs
  let warned = false

  while (true) {
    // Each poll is progress as far as a stall watchdog is concerned (a waiting job is not a wedged one), and an aborted
    // import must stop waiting instead of polling on.
    opts.onPoll?.()
    signal.throwIfAborted()

    let pressure: MemoryPressure
    try {
      pressure = await checkMemoryPressure(signal)
    } catch (err) {
      console.warn(
        '[clickhouse-memory-guard] pressure check failed, proceeding:',
        err instanceof Error ? err.message : String(err)
      )
      return
    }

    if (pressure.ratio < thresholdRatio) return

    if (Date.now() >= deadline) {
      console.warn(
        `[clickhouse-memory-guard] wait budget (${maxWaitMs}ms) exceeded at ` +
        `ratio ${pressure.ratio.toFixed(2)} -- proceeding anyway`
      )
      return
    }

    if (!warned) {
      console.warn(
        `[clickhouse-memory-guard] ClickHouse memory pressure ${(pressure.ratio * 100).toFixed(0)}% >= ` +
        `${(thresholdRatio * 100).toFixed(0)}% threshold -- pausing before next batch`
      )
      warned = true
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
}
