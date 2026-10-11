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
import { buildNormalizedDomainSetMatch, type MatchMode } from '@/lib/domain-match'
import { COMMIT_MAX_EXECUTION_S } from '@/lib/ingest-novelty-config'
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
