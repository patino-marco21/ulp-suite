import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'

// The runner only needs getClient from @/lib/clickhouse; every other export stays real.
const h = vi.hoisted(() => {
  const state = {
    probes: 0,
    probeFailures: 0, // the first N "SELECT 1" probes are refused, like a server that is not listening yet
    firstProbeAnswerAtExecs: -1,
    execs: [] as string[],
    queries: [] as string[],
    dropExecs: false, // every exec fails like a connection that was reset
    failExecWith: '' as string, // an exec whose SQL contains this fails with a server-side error
    indexes: [] as string[],
    columns: [] as string[],
  }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 172.20.0.2:8123'), { code: 'ECONNREFUSED' })
  const client = {
    query: vi.fn(async ({ query }: { query: string }) => {
      state.queries.push(query)
      if (query.trim() === 'SELECT 1') {
        state.probes++
        if (state.probes <= state.probeFailures) throw refused()
        if (state.firstProbeAnswerAtExecs < 0) state.firstProbeAnswerAtExecs = state.execs.length
        return { json: async () => [{ 1: 1 }] }
      }
      if (query.includes('system.data_skipping_indices')) return { json: async () => state.indexes.map(name => ({ name })) }
      if (query.includes('system.columns')) return { json: async () => state.columns.map(name => ({ name })) }
      return { json: async () => [] } // the v27 projection check
    }),
    exec: vi.fn(async ({ query }: { query: string }) => {
      state.execs.push(query)
      if (state.dropExecs) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      if (state.failExecWith && query.includes(state.failExecWith)) throw new Error('Code: 62. DB::Exception: Syntax error: failed at position 1')
      return {}
    }),
  }
  return { state, client }
})

vi.mock('@/lib/clickhouse', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/clickhouse')>()),
  getClient: () => h.client,
}))

const LIVE_INDEXES = [
  'idx_bf_breach_name', 'idx_bf_domain', 'idx_bf_email', 'idx_bf_email_domain', 'idx_bf_email_lc', 'idx_bf_password', 'idx_bf_source_file',
  'idx_bf_url_host', 'idx_inv_email', 'idx_inv_password', 'idx_inv_url', 'idx_mm_imported_at', 'idx_ngram_domain', 'idx_ngram_email_domain',
  'idx_ngram_url_host', 'idx_set_country_tier', 'idx_set_login_type', 'idx_set_password_entropy', 'idx_set_password_mask', 'idx_set_url_scheme',
]

const getSetting = (key: string): string | null => (dbGet(`SELECT value FROM app_settings WHERE key_name = ?`, [key]) as { value: string } | undefined)?.value ?? null
const setSetting = (key: string, value: string) => dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, ?)`, [key, value])
const clearSetting = (key: string) => dbRun(`DELETE FROM app_settings WHERE key_name = ?`, [key])

// A clock that only moves when the runner sleeps, so a wait of "45 seconds" takes no time.
function fakeWait(timeoutMs = 45_000) {
  let t = 0
  return { timeoutMs, sleep: async (ms: number) => { t += ms }, now: () => t }
}

describe('runClickHouseMigrations — start-up safeguards', () => {
  let run: typeof import('@/lib/clickhouse-migrations').runClickHouseMigrations
  let error: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.resetModules() // a fresh migrationsDone for every test
    ;({ runClickHouseMigrations: run } = await import('@/lib/clickhouse-migrations'))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
    Object.assign(h.state, { probes: 0, probeFailures: 0, firstProbeAnswerAtExecs: -1, dropExecs: false, failExecWith: '', indexes: [...LIVE_INDEXES] })
    h.state.execs.length = 0
    h.state.queries.length = 0
    h.state.columns = [
      'url', 'email', 'password', 'domain', 'source_file', 'imported_at', 'breach_name', 'tld', 'email_domain', 'country_tier', 'login_type',
      'password_length', 'password_mask', 'url_scheme', 'is_corporate_email', 'url_host', 'password_entropy_band', 'is_noise', 'content_key_hash',
      'was_duplicated',
    ]
    setSetting('ch_ddl_version', '28') // an upgrade from the last release: only the v29 block has work to do
    setSetting('ch_repair_mutations_fired', '1')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('asks a real query first and runs nothing until the server answers it', async () => {
    h.state.probeFailures = 3
    await run({ wait: fakeWait() })
    expect(h.state.probes).toBe(4)
    expect(h.state.firstProbeAnswerAtExecs).toBe(0) // not one statement was sent before the first answer
    expect(h.state.execs.some(sql => sql.includes('idx_bf_email_lc'))).toBe(true)
    expect(getSetting('ch_ddl_version')).toBe('29')
    // once, however many times it had to ask: the log is what tells a person why the start took a few seconds longer
    const waiting = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('not accepting connections yet'))
    expect(waiting).toHaveLength(1)
  })

  test('a server that answers at once logs nothing about waiting', async () => {
    await run({ wait: fakeWait() })
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('not accepting connections yet'))).toBe(false)
  })

  test('a server that never answers: nothing is run, nothing is recorded, and the log says so', async () => {
    h.state.probeFailures = Number.POSITIVE_INFINITY
    await run({ wait: fakeWait(5_000) })
    expect(h.state.execs).toEqual([])
    expect(getSetting('ch_ddl_version')).toBe('28')
    const lines = error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(lines).toContain('no DDL was run')
  })

  test('after such a failure a call within the minute returns at once, a later one asks again', async () => {
    h.state.probeFailures = Number.POSITIVE_INFINITY
    await run({ wait: fakeWait(1_000) })
    const asked = h.state.probes
    await run({ wait: fakeWait(1_000) })
    expect(h.state.probes).toBe(asked) // every upload request calls the runner: it must not wait 45 s each time

    vi.setSystemTime(new Date('2026-10-17T12:01:01Z'))
    h.state.probeFailures = 0
    await run({ wait: fakeWait() })
    expect(h.state.probes).toBeGreaterThan(asked)
    expect(getSetting('ch_ddl_version')).toBe('29')
  })

  test('a connection lost during the run keeps the version, leaves the repair mutations unfired, and the next call runs it all again', async () => {
    clearSetting('ch_repair_mutations_fired')
    h.state.dropExecs = true
    await run({ wait: fakeWait() })
    expect(getSetting('ch_ddl_version')).toBe('28')
    expect(getSetting('ch_repair_mutations_fired')).toBeNull()
    expect(h.state.queries.some(q => q.includes('system.data_skipping_indices'))).toBe(false) // no schema check against a server that just dropped us
    expect(error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('connection')

    h.state.dropExecs = false
    h.state.execs.length = 0
    vi.setSystemTime(new Date('2026-10-17T12:02:00Z'))
    await run({ wait: fakeWait() })
    expect(h.state.execs.some(sql => sql.includes('idx_bf_email_lc'))).toBe(true)
    expect(getSetting('ch_ddl_version')).toBe('29')
    expect(getSetting('ch_repair_mutations_fired')).toBe('1')
  })

  test('a server-side failure of the v29 ADD INDEX still keeps the version at 28, as before', async () => {
    h.state.failExecWith = 'idx_bf_email_lc'
    await run({ wait: fakeWait() })
    expect(getSetting('ch_ddl_version')).toBe('28')
  })

  test('a finished run is done for the process: the second call sends nothing', async () => {
    await run({ wait: fakeWait() })
    const sent = h.state.execs.length
    const asked = h.state.queries.length
    await run({ wait: fakeWait() })
    expect(h.state.execs.length).toBe(sent)
    expect(h.state.queries.length).toBe(asked)
  })

  test('the schema check runs after every completed run, even when the version is already current, and adds what is missing', async () => {
    setSetting('ch_ddl_version', '29')
    h.state.indexes = LIVE_INDEXES.filter(n => n !== 'idx_inv_url' && n !== 'idx_ngram_domain')
    await run({ wait: fakeWait() })
    expect(h.state.execs).toHaveLength(2)
    expect(h.state.execs.some(sql => sql.includes('idx_inv_url'))).toBe(true)
    expect(h.state.execs.some(sql => sql.includes('idx_ngram_domain'))).toBe(true)
    expect(getSetting('ch_ddl_version')).toBe('29')
  })

  test('a complete schema on a current install costs the probe and two metadata queries, and no statement', async () => {
    setSetting('ch_ddl_version', '29')
    await run({ wait: fakeWait() })
    expect(h.state.execs).toEqual([])
    expect(h.state.queries).toHaveLength(3)
  })
})
