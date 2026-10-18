/**
 * Start-up safeguards for lib/clickhouse-migrations.ts.
 *
 * The runner swallows every error that is not "already exists" and then records the DDL version as done, so a first start on an empty data directory
 * (disaster recovery, a new laptop) could finish "successfully" without a single statement having reached the server: the docker health check passes
 * against the temporary server the entrypoint runs for the init scripts, the app starts, and the real server is not listening yet. Measured 2026-10-13
 * on the isolated stack: 480 x ECONNREFUSED, "DDL now at v29", and none of the nine skip indexes below.
 *
 * Three small pieces close that gap without touching what a healthy start does:
 *  - waitForClickHouse: ask a real query until the server answers, instead of assuming it does.
 *  - trackConnectionLoss: remember that a statement never reached the server, so the version is not recorded and the next start runs the block again.
 *  - verifySchema: after the blocks, compare the skip indexes and columns the migrations own with the live table and add what is missing.
 */
import { SEARCH_INDEX_DEFINITIONS } from '@/lib/search-index-definitions'

export interface WaitOptions {
  /** How long to keep asking a server that is not listening. */
  timeoutMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface IndexDefinition {
  name: string
  addSql: string
}

export interface SchemaReport {
  missingIndexes: string[]
  addedIndexes: string[]
  failedIndexes: string[]
  missingColumns: string[]
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
])
const CONNECTION_TEXT = /socket hang up|socket was closed or ended|timeout error|\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE)\b/i

/**
 * True when the statement may not have reached ClickHouse: a refused or dropped connection, a name that did not resolve, a request that timed out.
 * A server-side error (syntax, settings, "already exists", authentication) is an answer and is not one. Node reports a dual-stack connect failure as an
 * AggregateError with an empty message, so the code is looked for on the error, its cause and its inner errors.
 */
export function isConnectionError(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined || depth > 3) return false
  if (typeof err === 'string') return CONNECTION_TEXT.test(err)
  if (typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  if (typeof e.code === 'string' && CONNECTION_CODES.has(e.code)) return true
  if (typeof e.message === 'string' && CONNECTION_TEXT.test(e.message)) return true
  if (isConnectionError(e.cause, depth + 1)) return true
  return Array.isArray(e.errors) && e.errors.some(inner => isConnectionError(inner, depth + 1))
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Asks `probe` (a real query) until it gets an answer. True once the server answered, even with an error of its own (the migrations then report that
 * themselves, as before); false when it stayed unreachable for the whole timeout, in which case nothing may be run or recorded.
 */
export async function waitForClickHouse(probe: () => Promise<unknown>, opts: WaitOptions = {}): Promise<boolean> {
  const { timeoutMs = 45_000, initialDelayMs = 500, maxDelayMs = 5_000, sleep = realSleep, now = Date.now } = opts
  const deadline = now() + timeoutMs
  let delay = initialDelayMs
  for (;;) {
    try {
      await probe()
      return true
    } catch (err) {
      if (!isConnectionError(err)) return true
      if (now() >= deadline) return false
      await sleep(delay)
      delay = Math.min(delay * 2, maxDelayMs)
    }
  }
}

/**
 * The same client, except that a connection error from exec/query/command is reported to `onLoss` (and still thrown). Every block of the runner goes
 * through it, so none of them has to know: a run that lost the connection once is not recorded as done.
 */
export function trackConnectionLoss<T extends object>(client: T, onLoss: () => void): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (prop !== 'exec' && prop !== 'query' && prop !== 'command') return value.bind(target)
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args)
        } catch (err) {
          if (isConnectionError(err)) onLoss()
          throw err
        }
      }
    },
  })
}

export function findMissing(expected: readonly string[], live: Iterable<string>): string[] {
  const have = new Set(live)
  return expected.filter(name => !have.has(name))
}

// The three indexes that are neither in the init SQL nor in SEARCH_INDEX_DEFINITIONS. DDL v2 and v19 add them with the same statements.
export const INDEX_BF_BREACH_NAME: IndexDefinition = {
  name: 'idx_bf_breach_name',
  addSql: `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_breach_name breach_name TYPE bloom_filter(0.01) GRANULARITY 1`,
}
export const INDEX_BF_SOURCE_FILE: IndexDefinition = {
  name: 'idx_bf_source_file',
  addSql: `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_source_file source_file TYPE bloom_filter(0.01) GRANULARITY 1`,
}
export const INDEX_NGRAM_DOMAIN: IndexDefinition = {
  name: 'idx_ngram_domain',
  addSql: `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_domain domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1`,
}

/**
 * The skip indexes only the migrations create (docker/clickhouse/init/01-ulp-tables.sql leaves them out: "the init SQL may run before migrations bump
 * ch_ddl_version"). A table restored or created without them still answers every query, only by scanning, and `hasToken` falls back to its
 * case-sensitive form.
 */
export const MIGRATION_INDEXES: IndexDefinition[] = [
  ...SEARCH_INDEX_DEFINITIONS.map(def => ({ name: def.name, addSql: def.addIndexSql('ulp.credentials') })),
  INDEX_BF_BREACH_NAME,
  INDEX_BF_SOURCE_FILE,
  INDEX_NGRAM_DOMAIN,
]

/** The columns the migrations add (`ADD COLUMN IF NOT EXISTS`); the init SQL defines all but was_duplicated. A table without one fails the queries that read it. */
export const MIGRATION_COLUMNS = [
  'breach_name',
  'tld',
  'email_domain',
  'country_tier',
  'login_type',
  'password_length',
  'password_mask',
  'url_scheme',
  'is_corporate_email',
  'url_host',
  'password_entropy_band',
  'is_noise',
  'content_key_hash',
  'was_duplicated',
]

interface SchemaClient {
  query(params: { query: string; format?: string }): Promise<{ json(): Promise<unknown> }>
  exec(params: { query: string }): Promise<unknown>
}

async function namesOf(client: SchemaClient, query: string): Promise<string[]> {
  const res = await client.query({ query, format: 'JSONEachRow' })
  return ((await res.json()) as Array<{ name: string }>).map(r => r.name)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).substring(0, 160)

/**
 * Compares the live ulp.credentials with what the migrations are responsible for. A missing skip index is added (metadata only: parts written from now on
 * carry it; existing parts need a supervised MATERIALIZE INDEX, never fired from start-up). A missing column is only reported: adding one is a decision
 * about a MATERIALIZED expression over every row. Best effort: it never throws, and a ClickHouse that cannot be asked is a warning.
 */
export async function verifySchema(client: SchemaClient): Promise<SchemaReport> {
  const report: SchemaReport = { missingIndexes: [], addedIndexes: [], failedIndexes: [], missingColumns: [] }
  try {
    const indexes = await namesOf(client, `SELECT name FROM system.data_skipping_indices WHERE database = 'ulp' AND table = 'credentials'`)
    const columns = await namesOf(client, `SELECT name FROM system.columns WHERE database = 'ulp' AND table = 'credentials'`)

    report.missingIndexes = findMissing(MIGRATION_INDEXES.map(i => i.name), indexes)
    for (const name of report.missingIndexes) {
      const def = MIGRATION_INDEXES.find(i => i.name === name)
      if (!def) continue
      try {
        await client.exec({ query: def.addSql })
        report.addedIndexes.push(name)
      } catch (err) {
        report.failedIndexes.push(name)
        console.error(`[ClickHouse migration] schema check: ADD INDEX ${name} -- FAILED:`, message(err))
      }
    }
    if (report.missingIndexes.length > 0) {
      console.error(
        `[ClickHouse migration] ulp.credentials was missing ${report.missingIndexes.length} skip index(es): ${report.missingIndexes.join(', ')}. ` +
          `Added: ${report.addedIndexes.join(', ') || 'none'} (metadata only: parts written from now on carry them; existing parts need ` +
          `ALTER TABLE ulp.credentials MATERIALIZE INDEX <name>, run supervised). Searches that rely on a missing index still answer, by scanning.`,
      )
    }

    report.missingColumns = findMissing(MIGRATION_COLUMNS, columns)
    if (report.missingColumns.length > 0) {
      console.error(
        `[ClickHouse migration] ulp.credentials has no column ${report.missingColumns.join(', ')}: the queries that read it fail. Nothing was altered ` +
          `(the ADD COLUMN IF NOT EXISTS statements in lib/clickhouse-migrations.ts add them; a MATERIALIZED column over every row is the owner's call).`,
      )
    }
  } catch (err) {
    console.warn('[ClickHouse migration] schema check skipped, ClickHouse could not be asked:', message(err))
  }
  return report
}
