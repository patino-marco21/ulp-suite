/**
 * Settings for novelty-aware ingest (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md), kept apart from the
 * commit code so that the inbox watcher and the tests can read them without loading the ClickHouse client.
 *
 *   INGEST_NOVELTY_CHECK      default on. off | 0 | false imports straight into ulp.credentials, exactly as before this feature.
 *   INGEST_NOVELTY_SLAB_ROWS  default 20,000,000, at least 1,000. A file is committed in slabs of about this many staged rows.
 */

export const DEFAULT_NOVELTY_SLAB_ROWS = 20_000_000
export const MIN_NOVELTY_SLAB_ROWS = 1_000

/** Every commit statement may run this long, in seconds. The client's own default is 60, far too short for a slab. */
export const COMMIT_MAX_EXECUTION_S = 3300

export interface NoveltyConfig {
  enabled: boolean
  slabRows: number
}

export function noveltyConfig(env: NodeJS.Dict<string> = process.env): NoveltyConfig {
  const flag = (env.INGEST_NOVELTY_CHECK ?? '').trim().toLowerCase()
  const enabled = !(flag === 'off' || flag === '0' || flag === 'false')
  const raw = env.INGEST_NOVELTY_SLAB_ROWS
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Math.floor(Number(raw))
  const slabRows = Number.isFinite(parsed) && parsed >= MIN_NOVELTY_SLAB_ROWS ? parsed : DEFAULT_NOVELTY_SLAB_ROWS
  return { enabled, slabRows }
}

/** How many slabs a stage of `stageRows` rows is committed in (always at least one). */
export function slabCount(stageRows: number, slabRows: number): number {
  if (!Number.isFinite(stageRows) || stageRows <= 0) return 1
  return Math.max(1, Math.ceil(stageRows / slabRows))
}
