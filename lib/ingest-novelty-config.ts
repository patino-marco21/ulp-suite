/**
 * Settings for novelty-aware ingest (docs/superpowers/specs/2026-10-02-novelty-aware-ingest-design.md), kept apart from the
 * commit code so that the inbox watcher and the tests can read them without loading the ClickHouse client.
 *
 *   INGEST_NOVELTY_CHECK      default on. off | 0 | false imports straight into ulp.credentials, exactly as before this feature.
 *   INGEST_NOVELTY_SLAB_ROWS  default 20,000,000, at least 1,000. A file is committed in slabs of about this many staged rows.
 *   INGEST_COMMIT_INSERT_THREADS  default 4, 1 to 16. The commit INSERT ... SELECT runs with this many insert threads
 *                                 (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step A2).
 *   INGEST_COMMIT_BLOCK_ROWS  default 131,072, 8,192 to 1,048,576. The commit INSERT ... SELECT builds blocks of this many rows (max_insert_block_size, min_insert_block_size_rows
 *                             and max_block_size); 1,048,576 is the server's own size, the behaviour before 2026-11-06.
 *   INGEST_NOVELTY_CHECK_GROUP  default 4, 1 to 16. At most this many slabs of one file share ONE existence check (one scan of the table's key column instead of one per slab); 1 is
 *                             the check slab by slab, the behaviour before 2026-11-06.
 *   INGEST_NORM_KEY           default on. off | 0 | false matches imports on the exact key (content_key_hash) everywhere. When on, the normalised key
 *                             (norm_key_hash) is used once every part of ulp.credentials holds it (lib/norm-key-ready.ts).
 */

export const DEFAULT_NOVELTY_SLAB_ROWS = 20_000_000
export const MIN_NOVELTY_SLAB_ROWS = 1_000

export const DEFAULT_COMMIT_INSERT_THREADS = 4
const MIN_COMMIT_INSERT_THREADS = 1
const MAX_COMMIT_INSERT_THREADS = 16

export const DEFAULT_CHECK_GROUP_SLABS = 4
const MAX_CHECK_GROUP_SLABS = 16

export const DEFAULT_COMMIT_BLOCK_ROWS = 131_072
const MIN_COMMIT_BLOCK_ROWS = 8_192
const MAX_COMMIT_BLOCK_ROWS = 1_048_576

/** Every commit statement may run this long, in seconds. The client's own default is 60, far too short for a slab. */
export const COMMIT_MAX_EXECUTION_S = 3300

/** The sort of a normalised-key commit spills to disk above this many bytes (max_bytes_before_external_sort) instead of growing ClickHouse's memory. */
export const COMMIT_EXTERNAL_SORT_BYTES = 1_073_741_824

/**
 * The most rows one slab holds on the normalised key, whatever INGEST_NOVELTY_SLAB_ROWS says (a smaller setting is kept). That statement sorts its slab,
 * and the spill bound above does not keep its memory flat: measured on ClickHouse 26.3 against the live DDL, one commit statement peaks at 10.6 GiB for
 * 20,000,000 rows and 7.1 GiB for 10,000,000, where the exact-key statement it replaces peaks at 8.0 GiB (20,000,000) and 7.5 GiB (10,000,000). The memory guard
 * starts a commit while the server is under 75% of its 14 GiB ceiling, so 10.6 GiB can be killed by the over-commit tracker and 7.1 GiB cannot.
 */
export const NORM_KEY_MAX_SLAB_ROWS = 10_000_000

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

/** INGEST_NORM_KEY: on unless `off`, `0` or `false`. Whether the normalised key may be used at all; lib/norm-key-ready.ts decides when it can be. */
export function normKeyEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  const flag = (env.INGEST_NORM_KEY ?? '').trim().toLowerCase()
  return !(flag === 'off' || flag === '0' || flag === 'false')
}

/**
 * `max_insert_threads` for the commit insert. The server's default (0) wrote the exact statement at 142k rows/s; 4 threads reached 452k and 8 gained
 * nothing more (measured on ClickHouse 26.3 against the live DDL, `LIMIT 1 BY` included). A value that is not a whole number from 1 to 16 means the default.
 */
export function commitInsertThreads(env: NodeJS.Dict<string> = process.env): number {
  const raw = env.INGEST_COMMIT_INSERT_THREADS
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Math.floor(Number(raw))
  return Number.isFinite(parsed) && parsed >= MIN_COMMIT_INSERT_THREADS && parsed <= MAX_COMMIT_INSERT_THREADS ? parsed : DEFAULT_COMMIT_INSERT_THREADS
}

/**
 * How many slabs of one file share one existence check. The check reads the whole key column of the table (2.8 billion rows, 21 GiB) whatever the slab holds, so a four-file batch
 * of 22 slabs read 61.8 billion rows and spent 618 s of its 1,116 s under the commit lock on it. Measured on the live table: a scan probing 10M keys took 21.4 s, probing 40M keys
 * 24.2 s (+13%, 457 MiB -> 1.75 GiB). A group of 4 slabs of at most 10M rows is therefore one scan of about 24 s instead of four of 21-28 s. A value outside 1 to 16 means the default.
 */
export function checkGroupSlabs(env: NodeJS.Dict<string> = process.env): number {
  const raw = env.INGEST_NOVELTY_CHECK_GROUP
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Math.floor(Number(raw))
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_CHECK_GROUP_SLABS ? parsed : DEFAULT_CHECK_GROUP_SLABS
}

/**
 * The block size of the commit insert. A slab holds only the rows that are NEW (about 15% of a file), 1.1-1.2M rows, which is two blocks of the server's default 1,048,576 rows,
 * and a block is processed by one thread: the 22 commits of a four-file batch used 2.5 cores of 16 and took 16.6 s each. Measured on a scratch clone of the live DDL (20 skip
 * indexes, 3 projections) for a 1.09M-row slab: default blocks 12.4 s at 4 threads and 12.8 s at 8 (no gain), 131,072-row blocks 5.3 s at 4 threads (6.3 cores), 65,536 rows with
 * 16 threads 4.3 s. The cost is parts: 5 per commit at 131,072 against 1. A value outside 8,192 to 1,048,576 means the default.
 */
export function commitBlockRows(env: NodeJS.Dict<string> = process.env): number {
  const raw = env.INGEST_COMMIT_BLOCK_ROWS
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Math.floor(Number(raw))
  return Number.isFinite(parsed) && parsed >= MIN_COMMIT_BLOCK_ROWS && parsed <= MAX_COMMIT_BLOCK_ROWS ? parsed : DEFAULT_COMMIT_BLOCK_ROWS
}

/** How many slabs a stage of `stageRows` rows is committed in (always at least one). */
export function slabCount(stageRows: number, slabRows: number): number {
  if (!Number.isFinite(stageRows) || stageRows <= 0) return 1
  return Math.max(1, Math.ceil(stageRows / slabRows))
}
