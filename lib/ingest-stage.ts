/**
 * Per-import stage tables for novelty-aware ingest (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md).
 *
 * Every file being imported is parsed into its own stage table, `ulp.zz_import_stage_<id>`, a plain MergeTree with the six insert
 * columns and the same `content_key_hash` the live table materialises. `ulp.zz_import_known_<id>` holds, one slab at a time, the
 * hashes of the stage that the live table already has. Both are dropped when the import ends; if the process dies first, the
 * sweeper drops what it left (at start-up, before the inbox starts, and hourly). The names start with `zz_`, which the backup
 * script already excludes.
 *
 * The registry of ids in use lives on globalThis: instrumentation.ts (the sweeper, the inbox watcher) and the route handlers are
 * separate webpack chunks, so plain module state would not be shared.
 */
import { randomBytes } from 'node:crypto'
import { getClient } from '@/lib/clickhouse'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'
import { withClickHouseRetry, type ClickHouseRetryOptions } from '@/lib/clickhouse-retry'

const DB = 'ulp'
const STAGE_PREFIX = 'zz_import_stage_'
const KNOWN_PREFIX = 'zz_import_known_'
const ID_PATTERN = /^[0-9a-f]{12}$/
const OWN_TABLE_PATTERN = /^zz_import_(stage|known)_[0-9a-f]{12}$/
const SWEEP_AFTER_MS = 30 * 60_000

export interface StageTables {
  id: string
  /** Fully qualified, e.g. ulp.zz_import_stage_0123456789ab. */
  stage: string
  known: string
}

export function newStageId(): string {
  return randomBytes(6).toString('hex')
}

export function stageTables(id: string): StageTables {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid stage id: ${JSON.stringify(id)}`)
  return { id, stage: `${DB}.${STAGE_PREFIX}${id}`, known: `${DB}.${KNOWN_PREFIX}${id}` }
}

/**
 * The stage. No skip indexes and no projections (it is written once and read a few times), `ORDER BY tuple()` so an insert does
 * not sort. `non_replicated_deduplication_window` makes a retried batch insert (same dedup token) a no-op; the accounting does not
 * depend on it. The part limits are raised so that a very large file cannot trip TOO_MANY_PARTS before the merges catch up.
 */
export function stageDdl(t: StageTables): string {
  return `CREATE TABLE IF NOT EXISTS ${t.stage} (
  url String,
  email String,
  password String,
  domain String,
  source_file String,
  breach_name String,
  content_key_hash UInt64 MATERIALIZED cityHash64(${URL_CONTENT_KEY}, email, password)
) ENGINE = MergeTree ORDER BY tuple()
SETTINGS non_replicated_deduplication_window = 10000, parts_to_delay_insert = 3000, parts_to_throw_insert = 6000`
}

export function knownDdl(t: StageTables): string {
  return `CREATE TABLE IF NOT EXISTS ${t.known} (content_key_hash UInt64) ENGINE = MergeTree ORDER BY content_key_hash`
}

/** Idempotent (`IF NOT EXISTS`), so it is safe inside the transient-error retry loop. */
export async function createStage(t: StageTables, retry: ClickHouseRetryOptions = {}): Promise<void> {
  await withClickHouseRetry(async signal => {
    const client = getClient()
    await client.command({ query: stageDdl(t), abort_signal: signal })
    await client.command({ query: knownDdl(t), abort_signal: signal })
  }, retry)
}

/** SYNC: in an Atomic database a plain DROP keeps the data for minutes, and a stage can be gigabytes. Tries both even if one fails. */
export async function dropStage(t: StageTables): Promise<void> {
  const client = getClient()
  let firstError: unknown
  for (const table of [t.stage, t.known]) {
    try {
      await client.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` })
    } catch (err) {
      firstError ??= err
    }
  }
  if (firstError !== undefined) throw firstError
}

// ── registry of stages in use ───────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __ulpActiveStages: Set<string> | undefined
}

const active = () => (globalThis.__ulpActiveStages ??= new Set<string>())

/** Call BEFORE createStage: the sweeper must never see a table of ours that is not registered. */
export function registerStage(id: string): void {
  active().add(id)
}

export function unregisterStage(id: string): void {
  active().delete(id)
}

export function activeStageIds(): string[] {
  return [...active()]
}

// ── orphan sweeper ──────────────────────────────────────────────────────────────────────────────────

export interface StageSweepDb {
  /** Names (without the database) of stage / known tables older than `minAgeSeconds`. */
  list(minAgeSeconds: number): Promise<string[]>
  drop(table: string): Promise<void>
}

function clickhouseSweepDb(): StageSweepDb {
  return {
    async list(minAgeSeconds) {
      const res = await getClient().query({
        query: `SELECT name FROM system.tables
                WHERE database = '${DB}' AND match(name, '^zz_import_(stage|known)_[0-9a-f]{12}$')
                  AND metadata_modification_time <= now() - toIntervalSecond({age:UInt32})
                ORDER BY name`,
        query_params: { age: Math.max(0, Math.floor(minAgeSeconds)) },
        format: 'JSONEachRow',
        clickhouse_settings: { use_query_cache: 0 },
      })
      return ((await res.json()) as Array<{ name: string }>).map(r => r.name)
    },
    async drop(table) {
      if (!OWN_TABLE_PATTERN.test(table)) throw new Error(`refusing to drop ${table}`)
      await getClient().command({ query: `DROP TABLE IF EXISTS ${DB}.${table} SYNC` })
    },
  }
}

/** Drops the stage and known tables that no import running in this process owns. Returns the names it dropped. */
export async function sweepOrphanStages(opts: { minAgeSeconds?: number; db?: StageSweepDb } = {}): Promise<string[]> {
  const db = opts.db ?? clickhouseSweepDb()
  const owned = new Set(activeStageIds())
  const dropped: string[] = []
  for (const name of await db.list(opts.minAgeSeconds ?? 0)) {
    if (!OWN_TABLE_PATTERN.test(name)) continue
    if (owned.has(name.slice(name.lastIndexOf('_') + 1))) continue
    try {
      await db.drop(name)
      dropped.push(name)
    } catch (err) {
      console.warn(`[ingest-stage] could not drop ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return dropped
}

declare global {
  // eslint-disable-next-line no-var
  var __ulpStageSweeper: ReturnType<typeof setInterval> | undefined
}

/**
 * Sweeps once now (nothing a previous process started can still be running) and then hourly, leaving anything younger than 30
 * minutes alone. The returned promise settles when the first sweep is done so that start-up can wait for it before the inbox
 * watcher begins; it never rejects.
 */
export async function startStageSweeper(opts: { intervalMs?: number } = {}): Promise<void> {
  if (globalThis.__ulpStageSweeper) return
  // console.warn, not console.log: the production build strips console.log (next.config removeConsole keeps error and warn).
  const run = async (minAgeSeconds: number, announce: boolean) => {
    try {
      const dropped = await sweepOrphanStages({ minAgeSeconds })
      if (dropped.length > 0) console.warn(`[ingest-stage] dropped ${dropped.length} orphan stage table(s): ${dropped.join(', ')}`)
      else if (announce) console.warn('[ingest-stage] start-up sweep: no orphan stage tables')
    } catch (err) {
      console.warn(`[ingest-stage] orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const timer = setInterval(() => void run(SWEEP_AFTER_MS / 1000, false), opts.intervalMs ?? 60 * 60_000)
  timer.unref?.()
  globalThis.__ulpStageSweeper = timer
  await run(0, true)
}
