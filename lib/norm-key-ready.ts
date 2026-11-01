/**
 * Which key an import matches on (docs/superpowers/specs/2026-11-01-near-duplicates-design.md).
 *
 *   exact  content_key_hash: the URL without its scheme and one trailing slash, the login and the password as stored (since 2026-06-28).
 *   norm   norm_key_hash:    also ignores a leading www., capitals in the host and in the login, and extra trailing slashes.
 *
 * norm is used only when INGEST_NORM_KEY is not off AND the column is complete: it exists, and every active part of ulp.credentials holds it. A part
 * that lacks the column computes it on the fly, which gives the right value but reads three columns instead of one, so an import must not take that
 * path; until the backfill (scripts/materialize-norm-key.sh) has finished the importer keeps the exact key, and the image can be deployed first.
 *
 * The check is metadata only (the catalogue, never the table), fails CLOSED (any error or odd answer means exact), and is remembered for 60 s when
 * ready and 5 s when not, like the Newest-first readiness gate (lib/newest-first.ts). A file chooses once, before its first slab, and never mixes keys.
 */
import { getClient } from '@/lib/clickhouse'
import { normKeyEnabled } from '@/lib/ingest-novelty-config'

export type MatchKey = 'norm' | 'exact'
export type KeyColumn = 'norm_key_hash' | 'content_key_hash'

export const keyColumnOf = (key: MatchKey): KeyColumn => (key === 'norm' ? 'norm_key_hash' : 'content_key_hash')

type Run = (sql: string) => Promise<Array<Record<string, unknown>>>

const READY_TTL_MS = 60_000
const NOT_READY_TTL_MS = 5_000

/** Three numbers from the catalogue: is the column defined, how many parts are active, and how many of them list the column. */
export function buildNormKeyReadySql(): string {
  return `SELECT
  (SELECT count() FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'norm_key_hash') AS defined,
  (SELECT count() FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active) AS parts,
  (SELECT uniqExact(name) FROM system.parts_columns WHERE database = 'ulp' AND table = 'credentials' AND active AND column = 'norm_key_hash') AS with_column`
}

/** Complete: the column is defined and every active part lists it. An empty table is complete. Anything odd is not. */
export function normKeyReadyFrom(row: Record<string, unknown> | undefined): boolean {
  const defined = Number(row?.defined)
  const parts = Number(row?.parts)
  const withColumn = Number(row?.with_column)
  return defined === 1 && Number.isFinite(parts) && Number.isFinite(withColumn) && parts === withColumn
}

async function clickhouseRun(sql: string): Promise<Array<Record<string, unknown>>> {
  const res = await getClient().query({ query: sql, format: 'JSONEachRow', clickhouse_settings: { use_query_cache: 0 } })
  return (await res.json()) as Array<Record<string, unknown>>
}

let cache: { at: number; ttl: number; ready: boolean } | null = null
let inflight: Promise<boolean> | null = null
let announced: MatchKey | null = null

/** Test seam. */
export function resetNormKeyReadyCache(): void {
  cache = null
  inflight = null
  announced = null
}

export async function isNormKeyReady(run: Run = clickhouseRun, now: () => number = Date.now): Promise<boolean> {
  if (cache && now() - cache.at < cache.ttl) return cache.ready
  if (inflight) return inflight
  inflight = (async () => {
    let ready = false
    try {
      const [row] = await run(buildNormKeyReadySql())
      ready = normKeyReadyFrom(row)
    } catch (err) {
      console.warn('[norm-key] the readiness check failed -- matching on the exact key:', err instanceof Error ? err.message : String(err))
    }
    cache = { at: now(), ttl: ready ? READY_TTL_MS : NOT_READY_TTL_MS, ready }
    return ready
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/** Says which key is in use when it changes (once per change, not per import): docker logs is where an operator looks. */
function announce(key: MatchKey, why?: string): MatchKey {
  if (announced !== key) {
    announced = key
    const which = key === 'norm' ? 'normalised key (norm_key_hash)' : 'exact key (content_key_hash)'
    console.warn(`[ingest-novelty] matching imports on the ${which}${why ? `: ${why}` : ''}`)
  }
  return key
}

/** The key one import matches on. Never throws. */
export async function resolveMatchKey(opts: { env?: NodeJS.Dict<string>; run?: Run; now?: () => number } = {}): Promise<MatchKey> {
  if (!normKeyEnabled(opts.env)) return announce('exact', 'INGEST_NORM_KEY is off')
  if (await isNormKeyReady(opts.run, opts.now)) return announce('norm')
  return announce('exact', 'norm_key_hash is not complete in every part yet')
}
