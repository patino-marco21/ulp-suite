/**
 * The search dictionary: two small derived tables behind the fast domain search.
 * Design and measurements: docs/superpowers/specs/2026-10-03-domain-search-dictionary-design.md
 *
 * Why. A domain-shaped term becomes `domain = x OR domain LIKE '%.x' OR url_host LIKE '%x%' OR email_domain LIKE '%x%'`, and ClickHouse
 * cannot prune any of it once two substring branches sit in the OR: `ORDER BY domain LIMIT 200` reads every granule before the term
 * (15-19 s in the app for the owner's real searches). The substring branches can be answered from the DISTINCT values instead:
 *   ulp.search_host_dict         (domain, url_host) pairs   85.2M rows, 1.99 GiB  -> which `domain` values hold a host containing x
 *   ulp.search_emaildomain_dict  (email_domain)             13.2M rows, 152 MiB   -> which email domains contain x
 * lib/search-dictionary-plan.ts turns those into pruning conjuncts. Both tables are DERIVED: dropped and rebuilt freely, never backed up
 * (scripts/clickhouse-backup.sh skips `search_`), plain MergeTree so a laptop resume that expires the Keeper session cannot make them read-only.
 *
 * Freshness fails CLOSED. The fingerprint of the live table (uuid, per-partition rows and block range, non-projection mutations) is
 * read BEFORE a build and stored in the COMMENT of both tables; the dictionary is fresh only when both comments equal the live
 * fingerprint, so an import, a delete, a partition swap or a table swap makes it stale and searches take today's query until the next build.
 */
import { createHash } from 'node:crypto'
import { executeQuery, getClient } from '@/lib/clickhouse'
import {
  checkDiskHeadroom, computeEffectiveFloorBytes, resolveDiskGuardOptions, formatBytes,
} from '@/lib/clickhouse-disk-guard'

export type Run = (sql: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
type Env = Record<string, string | undefined>

export const HOST_DICT_TABLE = 'ulp.search_host_dict'
export const EMAIL_DICT_TABLE = 'ulp.search_emaildomain_dict'
export const DICT_FORMAT_VERSION = 1
export const DICT_BUILD_LOG_COMMENT = 'search_dict_build'
const SHADOW_SUFFIX = '__new'
/** Free space a build needs above the disk guard's floor: the new copy lives next to the old one (2.14 GiB measured) plus merge slack. */
export const BUILD_HEADROOM_BYTES = 3 * 1024 ** 3

// ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function searchDictionaryEnabled(env: Env = process.env): boolean {
  const v = (env.SEARCH_DICTIONARY ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(v)
}
export const searchDictMaxDomains = (env: Env = process.env): number => envInt(env.SEARCH_DICT_MAX_DOMAINS, 3000)
export const searchDictMaxEmailDomains = (env: Env = process.env): number => envInt(env.SEARCH_DICT_MAX_EMAIL_DOMAINS, 300)
export const searchDictCronMinutes = (env: Env = process.env): number => envInt(env.SEARCH_DICT_CRON_MINUTES, 10)
export const searchDictSettleSeconds = (env: Env = process.env): number => envInt(env.SEARCH_DICT_SETTLE_SECONDS, 120)

// ── the fingerprint of the live table ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Mutations that cannot change what the dictionary holds: projection and index maintenance. lib/projection-scope-cron.ts runs `CLEAR PROJECTION`
 * on partition 202607 every day at 05:00Z, and without this exclusion that alone would invalidate the dictionary daily. NOTE the opening
 * parenthesis: system.mutations.command reads `(CLEAR PROJECTION proj_imported_desc IN PARTITION '202607')`, so an anchored `^CLEAR PROJECTION`
 * matches nothing (verified live 2026-10-03: this form excludes 18 of the 19 listed mutations; the one kept is MATERIALIZE COLUMN country_tier).
 * Index mutations are excluded too: the oldest history entries are DROP INDEX, and a spurious rebuild each time one ages out of the list is waste.
 * The doubled backslash is the SQL string literal's escape of one regex backslash.
 */
const NON_CONTENT_MUTATION = String.raw`match(command, '^\\(?(CLEAR|MATERIALIZE|DROP|ADD) (PROJECTION|INDEX)')`

/** One metadata query: the fingerprint inputs, plus whether a content mutation or a build is running. Never cached by ClickHouse. */
export function buildLiveStateSql(): string {
  return `SELECT
  (SELECT toString(uuid) FROM system.tables WHERE database = 'ulp' AND name = 'credentials') AS table_uuid,
  (SELECT arrayStringConcat(arraySort(groupArray(concat(partition, ':', toString(part_rows), ':', toString(min_block), ':', toString(max_block)))), ';')
     FROM (SELECT partition, sum(rows) AS part_rows, min(min_block_number) AS min_block, max(max_block_number) AS max_block
           FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active GROUP BY partition)) AS part_state,
  (SELECT arrayStringConcat(arraySort(groupArray(concat(mutation_id, ':', command))), ';')
     FROM system.mutations WHERE database = 'ulp' AND table = 'credentials' AND NOT ${NON_CONTENT_MUTATION}) AS mutation_state,
  (SELECT count() FROM system.mutations
     WHERE database = 'ulp' AND table = 'credentials' AND NOT is_done AND NOT ${NON_CONTENT_MUTATION}) AS mutations_running,
  (SELECT count() FROM system.processes WHERE log_comment = '${DICT_BUILD_LOG_COMMENT}') AS builds_running
SETTINGS use_query_cache = 0`
}

export interface LiveState {
  /** sha1 of the table uuid, the part state and the content-mutation list. */
  fingerprint: string
  /** Content mutations (not projection or index ones) that have not finished. */
  mutationsRunning: number
  /** Dictionary build queries currently running anywhere (this app, a script, another process). */
  buildsRunning: number
}

/** null for anything unusable (no row, no uuid, no active parts, a row of another shape): the caller fails closed. */
export function liveStateFromRow(row: Record<string, unknown> | undefined): LiveState | null {
  if (!row) return null
  const uuid = typeof row.table_uuid === 'string' ? row.table_uuid : ''
  const parts = typeof row.part_state === 'string' ? row.part_state : ''
  const mutations = typeof row.mutation_state === 'string' ? row.mutation_state : null
  if (uuid === '' || parts === '' || mutations === null) return null
  const fingerprint = createHash('sha1').update(`${uuid}|${parts}|${mutations}`).digest('hex')
  return { fingerprint, mutationsRunning: Number(row.mutations_running) || 0, buildsRunning: Number(row.builds_running) || 0 }
}

export async function readLiveState(run: Run = executeQuery): Promise<LiveState | null> {
  try {
    const [row] = await run(buildLiveStateSql())
    return liveStateFromRow(row)
  } catch {
    return null
  }
}

// ── the comment that marks what a dictionary was built from ─────────────────────────────────────────────────────────────────

export interface DictionaryComment {
  v: number
  fp: string
  builtAt: string
  rows: number | null
}

/** The comment sits inside a single-quoted DDL string, so a quote or backslash in any field is refused rather than escaped. */
export function encodeDictionaryComment(c: DictionaryComment): string {
  const json = JSON.stringify({ v: c.v, fp: c.fp, builtAt: c.builtAt, rows: c.rows })
  if (/['\\]/.test(json)) throw new Error('[search-dictionary] a comment field contains a quote or backslash')
  return json
}

export function parseDictionaryComment(raw: unknown): DictionaryComment | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (o.v !== DICT_FORMAT_VERSION || typeof o.fp !== 'string' || o.fp.length < 8 || typeof o.builtAt !== 'string') return null
    return { v: o.v, fp: o.fp, builtAt: o.builtAt, rows: typeof o.rows === 'number' ? o.rows : null }
  } catch {
    return null
  }
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DictionaryState = 'fresh' | 'stale' | 'missing' | 'building' | 'disabled' | 'unknown'

export interface DictionaryTableInfo {
  /** Without the database: `search_host_dict`. */
  name: string
  comment: unknown
  rows: number
  bytes: number
}

export interface DictionaryStatus {
  state: DictionaryState
  /** The fingerprint the SERVING dictionary was built from; null unless fresh. */
  fingerprint: string | null
  builtAt: string | null
  pairRows: number | null
  emailRows: number | null
  bytes: number | null
  lastError: string | null
  lastBuildMs: number | null
}

const blankStatus = (state: DictionaryState): DictionaryStatus => ({
  state, fingerprint: null, builtAt: null, pairRows: null, emailRows: null, bytes: null, lastError: null, lastBuildMs: null,
})

/** Pure: what the live state and the two tables say. */
export function evaluateDictionaryState(input: { enabled: boolean; live: LiveState | null; tables: DictionaryTableInfo[] }): DictionaryStatus {
  if (!input.enabled) return blankStatus('disabled')
  if (!input.live) return blankStatus('unknown')
  const host = input.tables.find(t => t.name === 'search_host_dict')
  const email = input.tables.find(t => t.name === 'search_emaildomain_dict')
  const sizes = {
    pairRows: host?.rows ?? null,
    emailRows: email?.rows ?? null,
    bytes: host && email ? host.bytes + email.bytes : null,
  }
  if (input.live.buildsRunning > 0) return { ...blankStatus('building'), ...sizes }
  if (!host || !email) return { ...blankStatus('missing'), ...sizes }
  const hostComment = parseDictionaryComment(host.comment)
  const emailComment = parseDictionaryComment(email.comment)
  const fresh = hostComment !== null && emailComment !== null
    && hostComment.fp === input.live.fingerprint && emailComment.fp === input.live.fingerprint
  return {
    ...blankStatus(fresh ? 'fresh' : 'stale'), ...sizes,
    fingerprint: fresh ? input.live.fingerprint : null,
    builtAt: hostComment?.builtAt ?? null,
  }
}

interface BuildRecord { lastError: string | null; lastBuildMs: number | null; lastBuiltAt: string | null }
// The cron runs in the instrumentation chunk and the routes in their own: module-scope state would not be shared (see instrumentation.ts),
// so what a build leaves behind for the status lives on globalThis.
const G = globalThis as unknown as { __ulpSearchDictionary?: BuildRecord }
const record = (): BuildRecord => (G.__ulpSearchDictionary ??= { lastError: null, lastBuildMs: null, lastBuiltAt: null })

export function recordBuildOutcome(patch: Partial<BuildRecord>): void {
  Object.assign(record(), patch)
}
export function readBuildRecord(): BuildRecord {
  return { ...record() }
}
const withRecord = (s: DictionaryStatus): DictionaryStatus => ({ ...s, lastError: record().lastError, lastBuildMs: record().lastBuildMs })

const TABLES_SQL = `SELECT name, comment, total_rows AS table_rows, total_bytes AS table_bytes
FROM system.tables
WHERE database = 'ulp' AND name IN ('search_host_dict', 'search_emaildomain_dict')
SETTINGS use_query_cache = 0`

const STATUS_TTL_MS = 3_000
const STATUS_FAILED_TTL_MS = 5_000
let statusCache: { at: number; ttl: number; value: DictionaryStatus } | null = null
let statusInflight: Promise<DictionaryStatus> | null = null

export function resetSearchDictionaryCache(): void {
  statusCache = null
  statusInflight = null
}

/**
 * Never throws: any ClickHouse trouble is `unknown`, which no caller treats as fresh. Cached 3 s (5 s after a failure): a verdict of `fresh` is the
 * one answer that must not outlive a change to the data, because for that long a search could use candidates that miss a row with a NEW domain.
 */
export async function getSearchDictionaryStatus(run: Run = executeQuery, now: () => number = Date.now): Promise<DictionaryStatus> {
  const enabled = searchDictionaryEnabled()
  if (!enabled) return withRecord(blankStatus('disabled'))
  const t = now()
  if (statusCache && t - statusCache.at < statusCache.ttl) return withRecord(statusCache.value)
  if (statusInflight) return withRecord(await statusInflight)

  statusInflight = (async () => {
    let value = blankStatus('unknown')
    let ttl = STATUS_FAILED_TTL_MS
    try {
      const [live, tableRows] = await Promise.all([readLiveState(run), run(TABLES_SQL)])
      const tables: DictionaryTableInfo[] = tableRows.map(r => ({
        name: String(r.name), comment: r.comment, rows: Number(r.table_rows) || 0, bytes: Number(r.table_bytes) || 0,
      }))
      value = evaluateDictionaryState({ enabled, live, tables })
      if (value.state !== 'unknown') ttl = STATUS_TTL_MS
    } catch (err) {
      console.warn('[search-dictionary] status check failed -- treating the dictionary as unavailable:', err instanceof Error ? err.message : String(err))
    }
    statusCache = { at: now(), ttl, value }
    return value
  })()
  try {
    return withRecord(await statusInflight)
  } finally {
    statusInflight = null
  }
}

// ── the build ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Not a failure: the disk is too full to hold a second copy. The cron skips the tick and tries again later. */
export class DictionaryHeadroomError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DictionaryHeadroomError'
  }
}

export interface BuildClient {
  command(args: { query: string; clickhouse_settings?: Record<string, string | number | boolean> }): Promise<unknown>
}

export interface BuildOptions {
  client?: BuildClient
  run?: Run
  now?: () => Date
  log?: (message: string) => void
  /** Skip the free-space check: a supervised first build on a disk the operator has looked at. */
  skipHeadroomCheck?: boolean
}

export interface BuildResult {
  pairRows: number
  emailRows: number
  ms: number
  fingerprint: string
}

/** Measured 2026-10-03: pairs 129 s with a 3.78 GiB peak, email domains 20 s with 1.71 GiB; both stay far under these limits. */
const BUILD_SETTINGS = {
  max_threads: 8,
  max_memory_usage: 6_000_000_000,
  max_bytes_before_external_group_by: 3_000_000_000,
  async_insert: 0,
  max_execution_time: 1800,
  log_comment: DICT_BUILD_LOG_COMMENT,
  use_query_cache: 0,
}

async function assertHeadroom(): Promise<void> {
  let free: number
  let floor: number
  try {
    const headroom = await checkDiskHeadroom()
    free = headroom.freeBytes
    floor = computeEffectiveFloorBytes(resolveDiskGuardOptions(), headroom.totalBytes)
  } catch (err) {
    throw new DictionaryHeadroomError(`free space could not be read, so no build is started: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (free - BUILD_HEADROOM_BYTES < floor) {
    throw new DictionaryHeadroomError(
      `${formatBytes(free)} free would fall under the ${formatBytes(floor)} floor once the new copy (about ${formatBytes(BUILD_HEADROOM_BYTES)}) is written`,
    )
  }
}

/**
 * Rebuilds both tables into `<name>__new` and swaps them in (EXCHANGE TABLES; the first build has nothing to exchange and renames). The
 * fingerprint is read BEFORE the build and written to the new tables, so data that arrives meanwhile leaves them born stale and the next tick
 * rebuilds. Queries in flight finish on the old table. A failure drops the shadow tables and leaves the serving ones untouched.
 */
export async function buildSearchDictionary(opts: BuildOptions = {}): Promise<BuildResult> {
  const run: Run = opts.run ?? executeQuery
  const client: BuildClient = opts.client ?? (getClient() as unknown as BuildClient)
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? ((message: string) => console.warn(`[search-dictionary] ${message}`))
  const startedAt = Date.now()

  const live = await readLiveState(run)
  if (!live) throw new Error('[search-dictionary] the live fingerprint could not be read; refusing to build')
  if (live.buildsRunning > 0) throw new Error('[search-dictionary] another build of the search dictionary is already running')
  if (!opts.skipHeadroomCheck) await assertHeadroom()

  const builtAt = now().toISOString()
  const comment = (rows: number | null) => encodeDictionaryComment({ v: DICT_FORMAT_VERSION, fp: live.fingerprint, builtAt, rows })
  const shadow = (table: string) => `${table}${SHADOW_SUFFIX}`
  const specs = [
    {
      table: HOST_DICT_TABLE,
      ddl: '(domain String, url_host String) ENGINE = MergeTree ORDER BY (domain, url_host)',
      fill: 'SELECT domain, url_host FROM ulp.credentials GROUP BY domain, url_host',
    },
    {
      table: EMAIL_DICT_TABLE,
      ddl: '(email_domain String) ENGINE = MergeTree ORDER BY email_domain',
      fill: 'SELECT email_domain FROM ulp.credentials GROUP BY email_domain',
    },
  ]
  const dropShadows = async () => {
    for (const s of specs) await client.command({ query: `DROP TABLE IF EXISTS ${shadow(s.table)} SYNC` })
  }

  const counts: number[] = []
  try {
    await dropShadows()
    for (const s of specs) await client.command({ query: `CREATE TABLE ${shadow(s.table)} ${s.ddl} COMMENT '${comment(null)}'` })
    for (const s of specs) {
      log(`filling ${shadow(s.table)}`)
      await client.command({ query: `INSERT INTO ${shadow(s.table)} ${s.fill}`, clickhouse_settings: BUILD_SETTINGS })
      await client.command({ query: `OPTIMIZE TABLE ${shadow(s.table)} FINAL`, clickhouse_settings: { max_execution_time: 1800, optimize_throw_if_noop: 0 } })
      const [row] = await run(`SELECT count() AS n FROM ${shadow(s.table)} SETTINGS use_query_cache = 0`)
      const n = Number(row?.n)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`[search-dictionary] ${shadow(s.table)} is empty after the build; not swapping it in`)
      counts.push(n)
      await client.command({ query: `ALTER TABLE ${shadow(s.table)} MODIFY COMMENT '${comment(n)}'` })
    }
    for (const s of specs) {
      const name = s.table.split('.')[1]
      const [row] = await run(`SELECT count() AS n FROM system.tables WHERE database = 'ulp' AND name = '${name}' SETTINGS use_query_cache = 0`)
      const exists = Number(row?.n) > 0
      await client.command({ query: exists ? `EXCHANGE TABLES ${shadow(s.table)} AND ${s.table}` : `RENAME TABLE ${shadow(s.table)} TO ${s.table}` })
      // after an EXCHANGE the shadow name holds the OLD copy; after a RENAME there is nothing left to drop
      await client.command({ query: `DROP TABLE IF EXISTS ${shadow(s.table)} SYNC` })
    }
  } catch (err) {
    await dropShadows().catch(() => {})
    recordBuildOutcome({ lastError: err instanceof Error ? err.message : String(err) })
    throw err
  }

  const ms = Date.now() - startedAt
  resetSearchDictionaryCache()
  recordBuildOutcome({ lastError: null, lastBuildMs: ms, lastBuiltAt: builtAt })
  log(`built: ${counts[0]} host pairs, ${counts[1]} email domains in ${Math.round(ms / 1000)}s (fingerprint ${live.fingerprint.slice(0, 12)})`)
  return { pairRows: counts[0], emailRows: counts[1], ms, fingerprint: live.fingerprint }
}
