import { readFileSync } from 'fs'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

// content-dedup and the modules it imports only need getClient from @/lib/clickhouse.
const h = vi.hoisted(() => {
  const state = { rows: 1000, statsCalls: 0, rowCountCalls: 0, failRowCount: false }
  const client = {
    exec: vi.fn(),
    query: vi.fn(async ({ query }: { query: string }) => {
      if (query.includes('FROM system.parts')) {
        state.rowCountCalls++
        if (state.failRowCount) throw new Error('keeper unavailable')
        return { json: async () => [{ rows: String(state.rows) }] }
      }
      if (query.includes('GROUP BY content_key_hash')) {
        state.statsCalls++
        return { json: async () => [{ total: String(state.rows), distinctCreds: String(state.rows) }] }
      }
      throw new Error(`unexpected query in test: ${query.slice(0, 80)}`)
    }),
  }
  return { state, client }
})

vi.mock('@/lib/clickhouse', () => ({ getClient: () => h.client }))

import {
  STATS_FORCE_INTERVAL_MS,
  shouldSkipStatsPass,
  buildTableRowCountSql,
} from '@/lib/content-dedup'

describe('buildTableRowCountSql', () => {
  test('reads the live row count from part metadata, never from a table scan', () => {
    const sql = buildTableRowCountSql()
    expect(sql).toContain('sum(rows)')
    expect(sql).toContain('FROM system.parts')
    expect(sql).toContain(`database = 'ulp' AND table = 'credentials'`)
    expect(sql).toContain('active')
    expect(sql).not.toContain('ulp.credentials')
  })
})

describe('shouldSkipStatsPass', () => {
  const now = 1_000_000_000_000
  const last = { rows: 1_393_449_551, at: now - 60_000 }

  test('skips when the row count is unchanged and the previous pass is recent', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last, now })).toBe(true)
  })
  test('runs when rows were added (excess can only grow through inserts)', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_552, last, now })).toBe(false)
  })
  test('runs when rows were removed too -- any change re-measures', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_550, last, now })).toBe(false)
  })
  test('runs when there is no previous pass (first tick after a restart)', () => {
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last: null, now })).toBe(false)
  })
  test('runs when the row count could not be read (fail open)', () => {
    expect(shouldSkipStatsPass({ rows: null, last, now })).toBe(false)
  })
  test('runs again once the previous pass is older than the forced-refresh interval', () => {
    const old = { rows: 1_393_449_551, at: now - STATS_FORCE_INTERVAL_MS - 1 }
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last: old, now })).toBe(false)
  })
  test('still skips one millisecond inside the interval', () => {
    const edge = { rows: 1_393_449_551, at: now - STATS_FORCE_INTERVAL_MS + 1 }
    expect(shouldSkipStatsPass({ rows: 1_393_449_551, last: edge, now })).toBe(true)
  })
  test('the forced refresh is 7 days', () => {
    expect(STATS_FORCE_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

function silenceConsole() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return { warn, restore: () => { warn.mockRestore(); error.mockRestore() } }
}

describe('runContentDedupTick — idle short-circuit', () => {
  let runContentDedupTick: typeof import('@/lib/content-dedup').runContentDedupTick
  let spies: ReturnType<typeof silenceConsole>

  beforeEach(async () => {
    vi.resetModules() // fresh module-level lastStatsPass for every test
    ;({ runContentDedupTick } = await import('@/lib/content-dedup'))
    // Fake timers only AFTER the dynamic import, so module loading never waits on a faked clock.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T04:00:00Z'))
    spies = silenceConsole()
    h.state.rows = 1000
    h.state.statsCalls = 0
    h.state.rowCountCalls = 0
    h.state.failRowCount = false
    delete process.env.CONTENT_DEDUP_APPLY // report-only: the tick returns right after the stats pass
  })

  afterEach(() => {
    vi.useRealTimers()
    spies.restore()
  })

  test('the first cron tick runs the full stats pass; a second tick with unchanged rows skips it', async () => {
    const first = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(first).toEqual({ total: 1000, excess: 0, applied: false })
    expect(h.state.statsCalls).toBe(1)

    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second).toEqual({ total: 1000, excess: 0, applied: false, skipped: true })
    expect(h.state.statsCalls).toBe(1) // not run again
    expect(spies.warn.mock.calls.some(c => String(c[0]).includes('skipping the stats scan'))).toBe(true)
  })

  test('runs the full pass again once rows have changed', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    h.state.rows = 1500
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second).toEqual({ total: 1500, excess: 0, applied: false })
    expect(h.state.statsCalls).toBe(2)
  })

  test('a manual tick (no skipIfUnchanged) never skips and never reads the row count', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(h.state.rowCountCalls).toBe(1)
    const manual = await runContentDedupTick({ trigger: 'manual' })
    expect(manual.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
    expect(h.state.rowCountCalls).toBe(1)
  })

  test('forces a full pass again after 7 days even when nothing changed', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    vi.setSystemTime(new Date('2026-10-09T04:00:00Z')) // 8 days later
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
  })

  test('fails open: an unreadable row count falls through to the full pass', async () => {
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    h.state.failRowCount = true
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
  })

  test('does not remember a pass whose row count could not be read', async () => {
    h.state.failRowCount = true
    await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    h.state.failRowCount = false
    const second = await runContentDedupTick({ trigger: 'cron', skipIfUnchanged: true })
    expect(second.skipped).toBeUndefined()
    expect(h.state.statsCalls).toBe(2)
  })

  test('an applying tick forgets the remembered pass before it touches anything (source contract)', () => {
    const src = readFileSync(new URL('../lib/content-dedup.ts', import.meta.url), 'utf8')
    const tick = src.slice(src.indexOf('export async function runContentDedupTick'))
    const reset = tick.indexOf('lastStatsPass = null')
    expect(reset).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(tick.indexOf('if (!willApply)'))
  })
})
