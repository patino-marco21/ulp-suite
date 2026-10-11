/**
 * Novelty-aware ingest, commit phase (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md).
 *
 * A file has been parsed into a stage table (lib/ingest-stage.ts). This module moves its rows into the real table one slab at a
 * time, so that only credentials the table does not hold yet are written:
 *
 *   known  = the slab's hashes that the table already has        (one scan of one column: about 10 s at 1.4B rows)
 *   insert = the slab's rows whose hash is not in `known`, one row per hash (LIMIT 1 BY), in one INSERT ... SELECT
 *
 * Retrying is therefore safe at any point. A retry recomputes `known`, which by then includes whatever an interrupted attempt
 * wrote, and inserts only the rest. That is also why the insert runs with insert_deduplicate = 0: a dedup token is only sound
 * for deterministic block formation, and a parallel read of the stage is not deterministic.
 *
 * The table is probed with the SMALL side (the slab's hashes), never `NOT IN (SELECT ... FROM <the big table>)`, which would
 * build a set of the whole table in memory (the lesson recorded in lib/content-dedup.ts).
 *
 * Settings travel as client settings: the client's default max_execution_time is 60 s and a slab takes minutes.
 */
import { randomUUID } from 'node:crypto'
import type { ClickHouseSettings } from '@clickhouse/client'
import { getClient } from '@/lib/clickhouse'
import { waitForHeadroom } from '@/lib/clickhouse-memory-guard'
import { buildNormalizedDomainSetMatch, type MatchedCredential, type MatchMode } from '@/lib/domain-match'
import { waitForDiskSpace } from '@/lib/ingest-disk-gate'
import { COMMIT_MAX_EXECUTION_S, slabCount } from '@/lib/ingest-novelty-config'
import type { StageTables } from '@/lib/ingest-stage'

// ── SQL builders (pure) ─────────────────────────────────────────────────────────────────────────────

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/

function qualified(name: string): string {
  if (!TABLE_NAME.test(name)) throw new Error(`invalid table name: ${JSON.stringify(name)}`)
  return name
}

/** The stage rows of slab `k` of `K`: the hash decides, so a credential always lands in the same slab. */
export function slabPredicate(K: number, k: number): string {
  if (!Number.isInteger(K) || !Number.isInteger(k) || K < 1 || k < 0 || k >= K) throw new Error(`bad slab ${k} of ${K}`)
  return `content_key_hash % ${K} = ${k}`
}

export const stageCountSql = (t: StageTables) => `SELECT count() AS c FROM ${t.stage}`

export const slabDistinctSql = (t: StageTables, K: number, k: number) =>
  `SELECT uniqExact(content_key_hash) AS c FROM ${t.stage} WHERE ${slabPredicate(K, k)}`

export const knownResetSql = (t: StageTables) => `TRUNCATE TABLE ${t.known}`

export const knownFillSql = (t: StageTables, against: string, K: number, k: number) =>
  `INSERT INTO ${t.known}\n` +
  `SELECT DISTINCT content_key_hash FROM ${qualified(against)}\n` +
  `WHERE content_key_hash IN (SELECT content_key_hash FROM ${t.stage} WHERE ${slabPredicate(K, k)})`

export const knownCountSql = (t: StageTables) => `SELECT count() AS c FROM ${t.known}`

export const commitInsertSql = (t: StageTables, target: string, K: number, k: number) =>
  `INSERT INTO ${qualified(target)} (url, email, password, domain, source_file, breach_name)\n` +
  `SELECT url, email, password, domain, source_file, breach_name FROM ${t.stage}\n` +
  `WHERE ${slabPredicate(K, k)} AND content_key_hash NOT IN (SELECT content_key_hash FROM ${t.known})\n` +
  `LIMIT 1 BY content_key_hash`

/**
 * The new rows of slab k that one monitor matches. The normalisation (lib/ulp-normalize.ts) is computed once per row in the inner
 * query and the domain set is tested with one arrayExists, so the cost does not grow with the number of monitored domains
 * (buildDomainSetWhereClause repeats the expression per domain: 2.3x slower at 17 domains). Same semantics as the in-process matcher.
 * Returns null when there is nothing to ask.
 */
export function monitorStageSql(
  t: StageTables,
  K: number,
  k: number,
  monitor: { domains: string[]; match_mode: MatchMode },
  limit: number,
): { sql: string; params: Record<string, unknown> } | null {
  const domains = monitor.domains.map(d => d.trim()).filter(d => d !== '')
  const cap = Math.floor(limit)
  if (domains.length === 0 || !(cap > 0)) return null
  const match = buildNormalizedDomainSetMatch(domains, monitor.match_mode)
  const sql =
    `SELECT url, email, password, domain FROM (\n` +
    `  SELECT url, email, password, domain, content_key_hash, ${match.normalizedColumns}\n` +
    `  FROM ${t.stage}\n` +
    `  WHERE ${slabPredicate(K, k)} AND content_key_hash NOT IN (SELECT content_key_hash FROM ${t.known})\n` +
    `) WHERE ${match.clause}\n` +
    `LIMIT 1 BY content_key_hash\n` +
    `LIMIT ${cap}`
  return { sql, params: match.params }
}

// ── the ClickHouse executor ─────────────────────────────────────────────────────────────────────────

export interface NoveltyDb {
  /** Runs a statement that returns no rows. `writtenRows` is the server's own count, or null when it sent none. */
  exec(sql: string, o: { queryId: string; signal: AbortSignal }): Promise<{ writtenRows: number | null }>
  select<T>(sql: string, o: { queryId: string; signal: AbortSignal; params?: Record<string, unknown> }): Promise<T[]>
  /** Best-effort KILL QUERY of a statement this module started. */
  kill(queryId: string): Promise<void>
}

const COMMIT_SETTINGS = {
  max_execution_time: COMMIT_MAX_EXECUTION_S,
  insert_deduplicate: 0,
  async_insert: 0,
  use_query_cache: 0,
} as unknown as ClickHouseSettings

const QUERY_ID = /^novelty-[0-9a-f-]{36}$/
const KILL_TIMEOUT_MS = 15_000

export const newQueryId = () => `novelty-${randomUUID()}`

export function clickhouseNoveltyDb(): NoveltyDb {
  return {
    async exec(sql, { queryId, signal }) {
      const res = await getClient().command({
        query: sql,
        query_id: queryId,
        abort_signal: signal,
        clickhouse_settings: COMMIT_SETTINGS,
      })
      const written = res.summary ? Number(res.summary.written_rows) : Number.NaN
      return { writtenRows: Number.isFinite(written) ? written : null }
    },

    async select<T>(sql: string, { queryId, signal, params }: { queryId: string; signal: AbortSignal; params?: Record<string, unknown> }) {
      const res = await getClient().query({
        query: sql,
        query_params: params,
        query_id: queryId,
        abort_signal: signal,
        format: 'JSONEachRow',
        clickhouse_settings: COMMIT_SETTINGS,
      })
      // Same guard as lib/upload-processor.ts: an abort while the body is being read must not leave the promise hanging.
      const closeOnAbort = () => res.close()
      signal.addEventListener('abort', closeOnAbort, { once: true })
      try {
        if (signal.aborted) {
          closeOnAbort()
          throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
        }
        return (await res.json()) as T[]
      } finally {
        signal.removeEventListener('abort', closeOnAbort)
      }
    },

    async kill(queryId) {
      // Interpolated, not a query parameter: the id is generated here and checked against a fixed shape.
      if (!QUERY_ID.test(queryId)) throw new Error(`invalid query id: ${JSON.stringify(queryId)}`)
      // Bounded: the kill runs while the commit lock is still held, and a ClickHouse that is frozen or unreachable must not keep
      // every other import waiting for the lock for as long as the client's own one-hour request timeout.
      await getClient().command({
        query: `KILL QUERY WHERE query_id = '${queryId}' SYNC`,
        abort_signal: AbortSignal.timeout(KILL_TIMEOUT_MS),
        clickhouse_settings: { max_execution_time: 60 } as unknown as ClickHouseSettings,
      })
    },
  }
}

// ── the process-wide commit lock ────────────────────────────────────────────────────────────────────

interface LockStore {
  tail: Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __ulpNoveltyLock: LockStore | undefined
}

const lockStore = () => (globalThis.__ulpNoveltyLock ??= { tail: Promise.resolve() })

/** Test seam. */
export function resetCommitLock(): void {
  globalThis.__ulpNoveltyLock = undefined
}

function waitOrAbort(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    void p.then(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

/**
 * One slab at a time across all imports in this process (the uploadQueue may run two files at once), so two imports never both
 * read "unknown" for the same new credential. First come, first served. The state lives on globalThis: instrumentation.ts (the
 * inbox watcher) and the route handlers are separate webpack chunks, so a module-level mutex would be two mutexes.
 * Resolves with an idempotent release function; rejects, without keeping its place, when `signal` aborts first.
 */
export async function acquireCommitLock(signal: AbortSignal): Promise<() => void> {
  const store = lockStore()
  const previous = store.tail
  let released = false
  let release!: () => void
  const mine = new Promise<void>(resolve => {
    release = () => {
      if (released) return
      released = true
      resolve()
    }
  })
  store.tail = previous.then(() => mine)
  try {
    await waitOrAbort(previous, signal)
  } catch (err) {
    release() // we never held it: let the chain move on
    throw err
  }
  return release
}

// ── the commit ──────────────────────────────────────────────────────────────────────────────────────

export class NoveltyAccountingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoveltyAccountingError'
  }
}

export interface CommitMonitor {
  id: number
  domains: string[]
  match_mode: MatchMode
}

export interface CommitGates {
  disk(signal: AbortSignal, o: { onPoll?: () => void }): Promise<void>
  memory(signal: AbortSignal, o: { onPoll?: () => void }): Promise<void>
}

export interface CommitOptions {
  tables: StageTables
  /** Table the new rows are written to. */
  target: string
  /** Table probed for rows already held. The same table in production; a probe may read the live table and write a clone. */
  noveltyAgainst: string
  /** Rows the parser kept and sent to the stage: the file's importable lines. */
  parsedRows: number
  slabRows: number
  signal: AbortSignal
  /** Progress heartbeat for the stall watchdog (lib/import-runner.ts): after every statement and on every gate poll. */
  beat?: () => void
  onPhase?: (e: { phase: 'checking' | 'inserting'; slab: number; slabs: number }) => void
  onSlab?: (e: { slab: number; slabs: number; known: number; inserted: number }) => void
  monitors?: CommitMonitor[]
  /** Most monitor matches to collect in total; 0 or absent = none. */
  matchCap?: number
  /** Test seams. */
  db?: NoveltyDb
  gates?: CommitGates
  newQueryId?: () => string
}

export interface CommitResult {
  /** Rows the parser kept. */
  rows: number
  /** Distinct credentials among them. */
  distinct: number
  /** Distinct credentials that the table already held. */
  known: number
  /** New rows written. */
  inserted: number
  /** Rows that repeat an earlier row of the same file: rows - distinct. */
  inFileDuplicates: number
  slabs: number
  matches: MatchedCredential[]
}

interface MonitorRow {
  url: string
  email: string
  password: string
  domain: string
}

async function countRows(db: NoveltyDb, sql: string, o: { queryId: string; signal: AbortSignal }): Promise<number> {
  const rows = await db.select<{ c: string | number }>(sql, o)
  return Number(rows[0]?.c ?? 0)
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Moves the stage's rows into `target`, one slab at a time. See the module comment. On any failure or abort the statement that
 * was running is killed before the lock is released, so no statement of ours is still writing while another import computes its
 * `known`. Rows an interrupted attempt already wrote are not rolled back: a retry counts them as known.
 */
export async function commitStage(opts: CommitOptions): Promise<CommitResult> {
  const db = opts.db ?? clickhouseNoveltyDb()
  const gates: CommitGates = opts.gates ?? { disk: waitForDiskSpace, memory: waitForHeadroom }
  const queryId = opts.newQueryId ?? newQueryId
  const beat = opts.beat ?? (() => {})
  const { signal, tables: t } = opts
  const monitors = (opts.monitors ?? []).filter(m => m.domains.some(d => d.trim() !== ''))
  const matchCap = Math.max(0, Math.floor(opts.matchCap ?? 0))
  const matches: MatchedCredential[] = []

  const stageRows = await countRows(db, stageCountSql(t), { queryId: queryId(), signal })
  beat()
  const slabs = slabCount(stageRows, opts.slabRows)
  let distinct = 0
  let known = 0
  let inserted = 0

  for (let k = 0; stageRows > 0 && k < slabs; k++) {
    signal.throwIfAborted()
    // Room first, THEN the lock: an import that is paused for disk or memory must not hold up another file's commit.
    await gates.disk(signal, { onPoll: beat })
    await gates.memory(signal, { onPoll: beat })
    const release = await acquireCommitLock(signal)

    let running: string | null = null
    // `running` is cleared only on success, so the catch below still knows which statement to kill.
    const step = async <T>(fn: (id: string) => Promise<T>): Promise<T> => {
      const id = queryId()
      running = id
      const out = await fn(id)
      running = null
      beat()
      return out
    }

    try {
      signal.throwIfAborted()
      const slabDistinct = await step(id => countRows(db, slabDistinctSql(t, slabs, k), { queryId: id, signal }))
      if (slabDistinct > 0) {
        opts.onPhase?.({ phase: 'checking', slab: k + 1, slabs })
        await step(id => db.exec(knownResetSql(t), { queryId: id, signal }))
        await step(id => db.exec(knownFillSql(t, opts.noveltyAgainst, slabs, k), { queryId: id, signal }))
        const slabKnown = await step(id => countRows(db, knownCountSql(t), { queryId: id, signal }))
        if (slabKnown > slabDistinct) {
          throw new NoveltyAccountingError(
            `slab ${k + 1}/${slabs}: ${slabKnown} known hashes for ${slabDistinct} distinct ones; the stage and the table disagree`,
          )
        }
        const expected = slabDistinct - slabKnown

        if (expected > 0) {
          opts.onPhase?.({ phase: 'inserting', slab: k + 1, slabs })
          const { writtenRows } = await step(id => db.exec(commitInsertSql(t, opts.target, slabs, k), { queryId: id, signal }))
          if (writtenRows === null) {
            console.warn(`[ingest-novelty] slab ${k + 1}/${slabs}: the server sent no written-rows count; the accounting check was skipped`)
          } else if (writtenRows !== expected) {
            throw new NoveltyAccountingError(
              `slab ${k + 1}/${slabs}: ClickHouse reported ${writtenRows} rows written but ${expected} were expected ` +
              `(${slabDistinct} distinct - ${slabKnown} known). Rows already written are kept; Retry is safe, they will count as already known.`,
            )
          }

          // Monitors see only rows that are new. A failed match query must not fail an import whose rows are already written
          // (a retry would count them as known, so their alerts could never fire): skip that monitor for this slab instead.
          for (const monitor of monitors) {
            const room = matchCap - matches.length
            if (room <= 0) break
            const q = monitorStageSql(t, slabs, k, monitor, room)
            if (!q) continue
            try {
              const rows = await step(id => db.select<MonitorRow>(q.sql, { queryId: id, signal, params: q.params }))
              for (const r of rows.slice(0, room)) matches.push({ monitorId: monitor.id, url: r.url, email: r.email, password: r.password, domain: r.domain })
            } catch (err) {
              if (signal.aborted) throw err
              running = null
              console.warn(`[ingest-novelty] monitor ${monitor.id}: its match query failed, so its alerts for slab ${k + 1}/${slabs} are skipped (${errorText(err)})`)
            }
          }
        }

        distinct += slabDistinct
        known += slabKnown
        inserted += expected
      }
      opts.onSlab?.({ slab: k + 1, slabs, known, inserted })
    } catch (err) {
      if (running !== null) await db.kill(running).catch(() => {})
      throw err
    } finally {
      release()
    }
  }

  return {
    rows: opts.parsedRows,
    distinct,
    known,
    inserted,
    inFileDuplicates: Math.max(0, opts.parsedRows - distinct),
    slabs,
    matches,
  }
}
