import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  searchTokenPlansEnabled, isTimeoutError, runWithBudget, probeTokenHits, resetSearchPlanGateCache,
  SUBSTRING_GATE_HITS, SUBSTRING_BUDGET_SECONDS, SUBSTRING_MAX_PROBES, PROBE_CAP_ROWS, PLAN_PROJECTIONS_OFF,
} from '@/lib/search-plan-gate'

beforeEach(() => { resetSearchPlanGateCache() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('the kill switch', () => {
  test('on unless SEARCH_TOKEN_PLANS says no', () => {
    expect(searchTokenPlansEnabled({})).toBe(true)
    expect(searchTokenPlansEnabled({ SEARCH_TOKEN_PLANS: '' })).toBe(true)
    expect(searchTokenPlansEnabled({ SEARCH_TOKEN_PLANS: '1' })).toBe(true)
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' 0 ']) expect(searchTokenPlansEnabled({ SEARCH_TOKEN_PLANS: v }), v).toBe(false)
  })

  test('reads the environment of the process by default', () => {
    vi.stubEnv('SEARCH_TOKEN_PLANS', 'off')
    expect(searchTokenPlansEnabled()).toBe(false)
  })
})

describe('the measured constants (spec 2026-10-13)', () => {
  test('gate 50,000 hits, budget 15 s, 8 probes, a probe counts one above the gate, projections off', () => {
    expect(SUBSTRING_GATE_HITS).toBe(50_000)
    expect(SUBSTRING_BUDGET_SECONDS).toBe(15)
    expect(SUBSTRING_MAX_PROBES).toBe(8)
    expect(PROBE_CAP_ROWS).toBe(SUBSTRING_GATE_HITS + 1)
    expect(PLAN_PROJECTIONS_OFF).toBe('optimize_use_projections = 0')
  })
})

describe('isTimeoutError and runWithBudget', () => {
  const timeout = new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 15.2 seconds, maximum: 15. (TIMEOUT_EXCEEDED)')

  test('recognises the ways a ClickHouse time limit shows up', () => {
    expect(isTimeoutError(timeout)).toBe(true)
    expect(isTimeoutError(new Error('socket timeout'))).toBe(true)
    expect(isTimeoutError(new Error('Request Timeout'))).toBe(true)
    expect(isTimeoutError(new Error('Code: 241. MEMORY_LIMIT_EXCEEDED'))).toBe(false)
    expect(isTimeoutError('TIMEOUT_EXCEEDED')).toBe(true)
    expect(isTimeoutError(undefined)).toBe(false)
  })

  test('hands back the value when the run succeeds', async () => {
    expect(await runWithBudget('x', async () => [1, 2])).toEqual({ ok: true, value: [1, 2] })
  })

  test('a timeout is "over the budget": ok false, reason budget, one warning that names the plan, and it never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWithBudget('substring rows', async () => { throw timeout })).toEqual({ ok: false, reason: 'budget' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('substring rows')
  })

  test('any other error is a failure: ok false, reason error, one warning with the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runWithBudget('substring totals', async () => { throw new Error('MEMORY_LIMIT_EXCEEDED') })).toEqual({ ok: false, reason: 'error' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0].join(' ')).toContain('MEMORY_LIMIT_EXCEEDED')
  })
})

describe('probeTokenHits', () => {
  const countRun = (hits: number) => vi.fn(async (_sql: string, _params: Record<string, unknown> = {}) => [{ hits: String(hits) }])

  test('a capped count through the three text-index leaves, with a time limit, no result cache and projections off', async () => {
    const run = countRun(1158)
    expect(await probeTokenHits('ledger', { run })).toBe(1158)
    const [sql, params] = run.mock.calls[0]
    expect(sql).toContain('hasToken(url, {tok:String}) OR hasToken(email, {tok:String}) OR hasToken(password, {tok:String})')
    expect(sql).toContain('FROM ulp.credentials')
    expect(sql).toContain('LIMIT {cap:UInt32}')
    expect(sql).toContain('use_query_cache = 0')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).toContain('max_execution_time = 8')
    expect(params).toEqual({ tok: 'ledger', cap: 50_001 })
  })

  test('the answer is kept ten minutes per word; another word looks again; then the first looks again too', async () => {
    const run = countRun(5)
    let t = 1_000
    const deps = { run, now: () => t }
    await probeTokenHits('ledger', deps)
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(1)
    await probeTokenHits('login', deps)
    expect(run).toHaveBeenCalledTimes(2)
    t += 599_000
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(2)
    t += 2_000
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(3)
  })

  test('two callers at once (the rows request and the totals request of one page) share ONE probe', async () => {
    const run = countRun(7)
    const [a, b] = await Promise.all([probeTokenHits('ledger', { run }), probeTokenHits('ledger', { run })])
    expect([a, b]).toEqual([7, 7])
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('a probe that fails is null with one warning, and is not retried for a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = vi.fn(async () => { throw new Error('boom') })
    let t = 5_000
    const deps = { run, now: () => t }
    expect(await probeTokenHits('ledger', deps)).toBeNull()
    expect(await probeTokenHits('ledger', deps)).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    t += 61_000
    await probeTokenHits('ledger', deps)
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('an answer that is not a count is a failure, not a zero', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await probeTokenHits('ledger', { run: vi.fn(async () => []) })).toBeNull()
    expect(await probeTokenHits('login', { run: vi.fn(async () => [{ hits: 'abc' }]) })).toBeNull()
  })

  test('keeps at most 500 words', async () => {
    const run = countRun(1)
    for (let i = 0; i < 520; i++) await probeTokenHits(`w${i}`, { run })
    expect(run).toHaveBeenCalledTimes(520)
    await probeTokenHits('w519', { run })
    expect(run).toHaveBeenCalledTimes(520)
    await probeTokenHits('w0', { run })
    expect(run).toHaveBeenCalledTimes(521)
  })
})
