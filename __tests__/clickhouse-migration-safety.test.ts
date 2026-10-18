import { readFileSync } from 'fs'
import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  INDEX_BF_BREACH_NAME,
  INDEX_BF_SOURCE_FILE,
  INDEX_NGRAM_DOMAIN,
  MIGRATION_COLUMNS,
  MIGRATION_INDEXES,
  findMissing,
  isConnectionError,
  trackConnectionLoss,
  verifySchema,
  waitForClickHouse,
} from '@/lib/clickhouse-migration-safety'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
const refused = () => nodeError('ECONNREFUSED', 'connect ECONNREFUSED 172.20.0.2:8123')

describe('isConnectionError', () => {
  test('a refused connection is one: the statement never reached ClickHouse', () => {
    expect(isConnectionError(refused())).toBe(true)
  })

  test.each(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'])(
    '%s is one, whatever the message says',
    code => {
      expect(isConnectionError(nodeError(code, 'x'))).toBe(true)
    },
  )

  test.each([
    'socket hang up',
    'The socket was closed or ended before the response was fully read. Consider increasing keep_alive.idle_socket_ttl',
    'Timeout error.',
  ])('the client text "%s" is one', message => {
    expect(isConnectionError(new Error(message))).toBe(true)
  })

  test('an AggregateError from a dual-stack connect has an empty message, the code is on the inner errors', () => {
    const err = Object.assign(new AggregateError([refused(), refused()]), { message: '' })
    expect(isConnectionError(err)).toBe(true)
  })

  test('the code may sit on the cause', () => {
    expect(isConnectionError(new Error('request failed', { cause: refused() }))).toBe(true)
  })

  test('a plain string that reads like one is one (the runner also stringifies unknown throws)', () => {
    expect(isConnectionError('connect ECONNREFUSED 10.0.0.1:8123')).toBe(true)
  })

  test.each([
    ['a server-side settings error', 'Code: 731. DB::Exception: QUERY_CACHE_USED_WITH_NON_THROW_OVERFLOW_MODE'],
    ['a syntax error', 'Code: 62. DB::Exception: Syntax error: failed at position 12'],
    ['an authentication failure', 'Code: 516. DB::Exception: default: Authentication failed'],
    ['an index that already exists', 'Code: 44. DB::Exception: Index idx_bf_email_lc already exists'],
  ])('%s is not: the server answered', (_name, message) => {
    expect(isConnectionError(new Error(message))).toBe(false)
  })

  test.each([null, undefined, '', 0, {}])('%j is not', value => {
    expect(isConnectionError(value)).toBe(false)
  })
})

function fakeClock() {
  let t = 0
  const slept: number[] = []
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms)
      t += ms
    },
  }
}

describe('waitForClickHouse', () => {
  test('returns true at once when the first query is answered, without sleeping', async () => {
    const clock = fakeClock()
    const probe = vi.fn(async () => [{ 1: 1 }])
    expect(await waitForClickHouse(probe, clock)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })

  test('keeps asking a refused server with a growing delay and returns true once it answers', async () => {
    const clock = fakeClock()
    let calls = 0
    const probe = vi.fn(async () => {
      if (++calls <= 4) throw refused()
      return []
    })
    expect(await waitForClickHouse(probe, { ...clock, timeoutMs: 60_000, initialDelayMs: 500, maxDelayMs: 5_000 })).toBe(true)
    expect(probe).toHaveBeenCalledTimes(5)
    expect(clock.slept).toEqual([500, 1_000, 2_000, 4_000])
  })

  test('the delay stops growing at the maximum', async () => {
    const clock = fakeClock()
    let calls = 0
    const probe = async () => {
      if (++calls <= 8) throw refused()
      return []
    }
    await waitForClickHouse(probe, { ...clock, timeoutMs: 600_000, initialDelayMs: 500, maxDelayMs: 5_000 })
    expect(clock.slept).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000])
  })

  test('gives up with false once the time is up, and stops asking', async () => {
    const clock = fakeClock()
    const probe = vi.fn(async () => {
      throw refused()
    })
    const up = await waitForClickHouse(probe, { ...clock, timeoutMs: 10_000, initialDelayMs: 500, maxDelayMs: 5_000 })
    expect(up).toBe(false)
    expect(clock.now()).toBeGreaterThanOrEqual(10_000)
    expect(clock.now()).toBeLessThanOrEqual(10_000 + 5_000)
    expect(probe.mock.calls.length).toBeGreaterThan(1)
    expect(probe.mock.calls.length).toBeLessThan(20)
  })

  test('an answer that is an error is still an answer: the migrations then report it themselves', async () => {
    const clock = fakeClock()
    const probe = vi.fn(async () => {
      throw new Error('Code: 516. DB::Exception: default: Authentication failed')
    })
    expect(await waitForClickHouse(probe, clock)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })
})

describe('trackConnectionLoss', () => {
  class Fake {
    tag = 'fake'
    failWith: unknown = null
    async exec(p: { query: string }) {
      if (this.failWith) throw this.failWith
      return { ran: p.query, by: this.tag }
    }
    async query(p: { query: string }) {
      if (this.failWith) throw this.failWith
      return { rows: p.query, by: this.tag }
    }
    close() {
      return `closed ${this.tag}`
    }
  }

  test('passes results through and keeps the client bound to itself', async () => {
    const onLoss = vi.fn()
    const client = trackConnectionLoss(new Fake(), onLoss)
    expect(await client.exec({ query: 'A' })).toEqual({ ran: 'A', by: 'fake' })
    expect(await client.query({ query: 'B' })).toEqual({ rows: 'B', by: 'fake' })
    expect(client.close()).toBe('closed fake')
    expect(onLoss).not.toHaveBeenCalled()
  })

  test('remembers a connection error from exec and still throws the very same error', async () => {
    const onLoss = vi.fn()
    const fake = new Fake()
    fake.failWith = refused()
    const client = trackConnectionLoss(fake, onLoss)
    await expect(client.exec({ query: 'A' })).rejects.toBe(fake.failWith)
    expect(onLoss).toHaveBeenCalledTimes(1)
  })

  test('remembers a connection error from query too', async () => {
    const onLoss = vi.fn()
    const fake = new Fake()
    fake.failWith = nodeError('ECONNRESET', 'read ECONNRESET')
    const client = trackConnectionLoss(fake, onLoss)
    await expect(client.query({ query: 'B' })).rejects.toBe(fake.failWith)
    expect(onLoss).toHaveBeenCalledTimes(1)
  })

  test('a server-side error is thrown unchanged and is not a lost connection', async () => {
    const onLoss = vi.fn()
    const fake = new Fake()
    fake.failWith = new Error('Code: 62. DB::Exception: Syntax error')
    const client = trackConnectionLoss(fake, onLoss)
    await expect(client.exec({ query: 'A' })).rejects.toBe(fake.failWith)
    expect(onLoss).not.toHaveBeenCalled()
  })
})

describe('findMissing', () => {
  test('lists what is expected and not there, in the expected order', () => {
    expect(findMissing(['a', 'b', 'c', 'd'], ['d', 'a', 'x'])).toEqual(['b', 'c'])
  })
  test('is empty when everything is there, extra names are ignored', () => {
    expect(findMissing(['a', 'b'], new Set(['b', 'a', 'z']))).toEqual([])
  })
})

describe('what the migrations, not the init SQL, are responsible for', () => {
  const NINE = [
    'idx_inv_url',
    'idx_inv_email',
    'idx_inv_password',
    'idx_ngram_url_host',
    'idx_ngram_email_domain',
    'idx_bf_email_lc',
    'idx_bf_breach_name',
    'idx_bf_source_file',
    'idx_ngram_domain',
  ]

  test('is exactly the nine skip indexes the init SQL does not create', () => {
    expect(MIGRATION_INDEXES.map(i => i.name).sort()).toEqual([...NINE].sort())
  })

  test('each one is an idempotent ADD INDEX on ulp.credentials under its own name', () => {
    for (const { name, addSql } of MIGRATION_INDEXES) {
      expect(addSql).toMatch(/^\s*ALTER TABLE ulp\.credentials ADD INDEX IF NOT EXISTS /)
      expect(addSql).toMatch(new RegExp(`\\b${name}\\b`))
      expect(addSql).not.toContain('MATERIALIZE') // start-up must not be coupled to a mutation
    }
  })

  test('the three that are not search definitions are the ones the v2 and v19 blocks add', () => {
    for (const def of [INDEX_BF_BREACH_NAME, INDEX_BF_SOURCE_FILE, INDEX_NGRAM_DOMAIN]) {
      expect(MIGRATION_INDEXES).toContainEqual(def)
    }
    const migrations = read('../lib/clickhouse-migrations.ts')
    // one definition each: the blocks use the shared constants instead of a second copy of the DDL
    expect(migrations).not.toMatch(/ADD INDEX IF NOT EXISTS idx_bf_breach_name/)
    expect(migrations).not.toMatch(/ADD INDEX IF NOT EXISTS idx_bf_source_file/)
    expect(migrations).not.toMatch(/ADD INDEX IF NOT EXISTS idx_ngram_domain/)
    expect(migrations).toContain('INDEX_BF_BREACH_NAME.addSql')
    expect(migrations).toContain('INDEX_BF_SOURCE_FILE.addSql')
    expect(migrations).toContain('INDEX_NGRAM_DOMAIN.addSql')
  })

  test('the columns are exactly those the migrations add', () => {
    const migrations = read('../lib/clickhouse-migrations.ts')
    const added = [...migrations.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+) (?:String|UInt\d+|LowCardinality)/g)].map(m => m[1])
    expect([...new Set(added)].sort()).toEqual([...MIGRATION_COLUMNS].sort())
  })
})

const LIVE_INDEXES = [
  'idx_bf_breach_name', 'idx_bf_domain', 'idx_bf_email', 'idx_bf_email_domain', 'idx_bf_email_lc', 'idx_bf_password', 'idx_bf_source_file',
  'idx_bf_url_host', 'idx_inv_email', 'idx_inv_password', 'idx_inv_url', 'idx_mm_imported_at', 'idx_ngram_domain', 'idx_ngram_email_domain',
  'idx_ngram_url_host', 'idx_set_country_tier', 'idx_set_login_type', 'idx_set_password_entropy', 'idx_set_password_mask', 'idx_set_url_scheme',
]
const LIVE_COLUMNS = ['url', 'email', 'password', 'domain', 'source_file', 'imported_at', ...MIGRATION_COLUMNS]

function schemaClient(o: { indexes?: string[]; columns?: string[]; failAdd?: string; failQuery?: boolean } = {}) {
  const execs: string[] = []
  const queries: string[] = []
  return {
    execs,
    queries,
    query: vi.fn(async ({ query }: { query: string }) => {
      queries.push(query)
      if (o.failQuery) throw refused()
      if (query.includes('system.data_skipping_indices')) return { json: async () => (o.indexes ?? LIVE_INDEXES).map(name => ({ name })) }
      if (query.includes('system.columns')) return { json: async () => (o.columns ?? LIVE_COLUMNS).map(name => ({ name })) }
      throw new Error(`unexpected query in test: ${query.slice(0, 80)}`)
    }),
    exec: vi.fn(async ({ query }: { query: string }) => {
      execs.push(query)
      if (o.failAdd && query.includes(o.failAdd)) throw new Error('Code: 62. DB::Exception: boom')
      return {}
    }),
  }
}

describe('verifySchema', () => {
  afterEach(() => vi.restoreAllMocks())

  test('a complete schema costs two metadata queries, runs nothing and logs nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = schemaClient()
    const report = await verifySchema(client)
    expect(report).toEqual({ missingIndexes: [], addedIndexes: [], failedIndexes: [], missingColumns: [] })
    expect(client.execs).toEqual([])
    expect(client.queries).toHaveLength(2)
    for (const q of client.queries) expect(q).toMatch(/database = 'ulp'/)
    for (const q of client.queries) expect(q).toMatch(/table = 'credentials'/)
    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test('adds exactly the indexes that are missing, only as metadata, and says so in an error line', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = schemaClient({ indexes: LIVE_INDEXES.filter(n => !['idx_inv_url', 'idx_inv_email', 'idx_ngram_domain'].includes(n)) })
    const report = await verifySchema(client)
    expect(report.missingIndexes.sort()).toEqual(['idx_inv_email', 'idx_inv_url', 'idx_ngram_domain'])
    expect(report.addedIndexes.sort()).toEqual(['idx_inv_email', 'idx_inv_url', 'idx_ngram_domain'])
    expect(report.failedIndexes).toEqual([])
    expect(client.execs).toHaveLength(3)
    for (const sql of client.execs) {
      expect(sql).toMatch(/ADD INDEX IF NOT EXISTS/)
      expect(sql).not.toMatch(/MATERIALIZE/)
    }
    expect(err).toHaveBeenCalledTimes(1)
    const line = String(err.mock.calls[0][0])
    expect(line).toContain('idx_inv_url')
    expect(line).toContain('idx_ngram_domain')
    expect(line).toMatch(/MATERIALIZE INDEX/) // the line tells the owner what an existing part still needs
  })

  test('an index that cannot be added is reported, and the others are still tried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = schemaClient({ indexes: LIVE_INDEXES.filter(n => n !== 'idx_inv_url' && n !== 'idx_bf_source_file'), failAdd: 'idx_inv_url' })
    const report = await verifySchema(client)
    expect(report.failedIndexes).toEqual(['idx_inv_url'])
    expect(report.addedIndexes).toEqual(['idx_bf_source_file'])
    expect(client.execs).toHaveLength(2)
  })

  test('missing columns are named in an error line and never altered', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = schemaClient({ columns: LIVE_COLUMNS.filter(c => c !== 'content_key_hash' && c !== 'is_noise') })
    const report = await verifySchema(client)
    expect(report.missingColumns.sort()).toEqual(['content_key_hash', 'is_noise'])
    expect(client.execs).toEqual([])
    const lines = err.mock.calls.map(c => String(c[0])).join('\n')
    expect(lines).toContain('content_key_hash')
    expect(lines).toContain('is_noise')
  })

  test('a check that cannot reach ClickHouse says so with a warning and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = schemaClient({ failQuery: true })
    await expect(verifySchema(client)).resolves.toEqual({ missingIndexes: [], addedIndexes: [], failedIndexes: [], missingColumns: [] })
    expect(client.execs).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})
