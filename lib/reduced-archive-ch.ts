/**
 * The ClickHouse side of the reduced archive writer (lib/reduced-archive.ts, ReduceDb): five scratch tables in the `default` database, named with a random suffix and
 * dropped again whatever happens, and a handful of statements. Nothing is written to `ulp`.
 *
 *   T  the credentials of the original file as the importer's parser reads them, with their byte span and the normalised key (`k`, the same expression as norm_key_hash)
 *   H  the keys of T that some stored row holds (once for each row that holds one: the scan streams them, nothing is aggregated in memory)
 *   S  the keys the database holds under the file's name, with their row counts
 *   C  for each distinct key of T that some row holds: whether this file's name is among the holders (`mine`), made from H and S
 *   R  the credentials of the reduced entry (same shape as T, no spans)
 *
 * A key of T is KEPT when it is `mine` (this file stored it) or in no row at all (`absent`); it is DROPPED when only other files hold it (`known`). Of a key that occurs
 * several times in the file only the first occurrence counts. A key can have several holders (look-alikes stored before the normalised check); it is mine when this file is
 * one of them.
 *
 * Memory: a file is cut into slabs of keys (`k % slabs = slab`), by the rows its parser read, and every statement that holds a set or a join in memory holds one slab of it.
 * Measured on a real ClickHouse: the keep statement joined the whole holders table in every slab and the proof built sets of every key, ~150 bytes a row, so a file of 20 million
 * rows used 3 GiB (the limit of 4 GB failed files over ~1.4 GiB, which hold two thirds of the archive) and a 4 GiB file would use 7 GiB. With slabs of 10 million rows no
 * statement passes ~1.6 GiB, whatever the size of the file. The one statement that reads all of ulp.credentials (presentSql, ~30 s) has its own, larger cut (`scanRows`): a pass over
 * the table costs the same for any number of keys, so a file is read in as few passes as fit the limit.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Ch } from '@/lib/clickhouse-cli'
import type { ClassifyResult, LoadRow, ProofCounts, ReduceDb } from '@/lib/reduced-archive'
import { sqlQuote } from '@/lib/source-archive'
import { normKeySql } from '@/lib/url-content-key'

/** One value as ClickHouse's TabSeparated input reads it back: backslash first, so the escapes added after it are not doubled. */
export function tsvEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0')
}

export function rowsToTsv(rows: LoadRow[]): string {
  let out = ''
  for (const r of rows) out += `${r.seq}\t${r.s}\t${r.e}\t${tsvEscape(r.url)}\t${tsvEscape(r.email)}\t${tsvEscape(r.password)}\n`
  return out
}

export const scratchDdl = (table: string) =>
  `CREATE TABLE ${table} (seq UInt64, s UInt64, e UInt64, url String, email String, password String, k UInt64 MATERIALIZED ${normKeySql()}) ENGINE = MergeTree ORDER BY tuple()`

/**
 * Appends to H the keys of one scan of T (`k % scans = scan`) that some stored row holds, each once. It reads the key column of ulp.credentials and nothing else: the statement it
 * replaces also asked each matching row for its file name, which read 91 GiB (uncompressed) and used 430 CPU-seconds where this reads 24 GiB and uses 280 (measured on the live
 * table, 3.25 billion rows). The cost of a pass is the same for any number of keys; the memory is not: the GROUP BY holds a key for each distinct key found, ~90 bytes (37 million
 * present keys: 3.47 GiB, one million: 0.16 GiB), which is why a scan holds 20 million keys at most. The GROUP BY must stay: the same statement without it, as a plain
 * INSERT ... SELECT, used 3.7 GiB (the limit of a statement) on a set of one million keys whatever the threads, blocks and prefetch, and failed.
 */
export const presentSql = (h: string, t: string, scans: number, scan: number) =>
  `INSERT INTO ${h} SELECT norm_key_hash FROM ulp.credentials WHERE norm_key_hash IN (SELECT k FROM ${t} WHERE k % ${scans} = ${scan}) GROUP BY norm_key_hash`

/** Fills C for one slab of keys (`k % slabs = slab`): the keys of H (each once: the scans are disjoint in k), each marked `mine` when the database holds it under the file's name (S). */
export const holdersSql = (c: string, h: string, s: string, slabs: number, slab: number) =>
  `INSERT INTO ${c} SELECT k, k IN (SELECT k FROM ${s} WHERE k % ${slabs} = ${slab}), 1 FROM ${h} WHERE k % ${slabs} = ${slab}`

/** The byte spans of the first occurrence of each key of one slab that is mine or absent, in file order: `start<TAB>end`. The holders joined are those of the slab only. */
export const keepSql = (t: string, c: string, slabs: number, slab: number) =>
  `SELECT f.s, f.e FROM (SELECT k, s, e FROM ${t} WHERE k % ${slabs} = ${slab} ORDER BY seq LIMIT 1 BY k) AS f ` +
  `LEFT JOIN (SELECT k, mine, present FROM ${c} WHERE k % ${slabs} = ${slab}) AS c ON f.k = c.k WHERE c.present = 0 OR c.mine = 1 ORDER BY f.s FORMAT TSV`

/**
 * The keys the database holds under the file's name, with their row counts. The aggregation spills to disk past 1 GB: a file with 36 million stored rows grew it to 3.7 GiB in one
 * piece (the hash table doubles as it fills) and failed the 4 GB limit of a statement; with the spill it peaks at 1.0 GiB and takes 9 s.
 */
export const keysOfNameSql = (s: string, name: string) =>
  `INSERT INTO ${s} SELECT norm_key_hash, count() FROM ulp.credentials WHERE source_file = ${sqlQuote(name)} GROUP BY norm_key_hash SETTINGS max_bytes_before_external_group_by = 1000000000`

/** What the database holds under the file's name: the rows and the distinct keys. One pass, no set in memory. */
export const storedSql = (s: string) => `SELECT sum(c), count() FROM ${s} FORMAT TSV`

/**
 * The counts of the proof for one slab of keys, as `notParsed, missing, spurious, extraKnown, reducedKeys`. The slabs are disjoint in k, so the counts of all slabs add up to
 * the counts of the whole file.
 */
export const proofSql = (t: string, c: string, r: string, s: string, slabs: number, slab: number) => {
  const m = `k % ${slabs} = ${slab}`
  return `SELECT ` +
    `(SELECT count() FROM ${s} WHERE ${m} AND k NOT IN (SELECT k FROM ${t} WHERE ${m})), ` +
    `(SELECT count() FROM ${s} WHERE ${m} AND k IN (SELECT k FROM ${t} WHERE ${m}) AND k NOT IN (SELECT k FROM ${r} WHERE ${m})), ` +
    `(SELECT uniqExact(k) FROM ${r} WHERE ${m} AND k NOT IN (SELECT k FROM ${t} WHERE ${m})), ` +
    `(SELECT uniqExact(k) FROM ${r} WHERE ${m} AND k IN (SELECT k FROM ${c} WHERE mine = 0 AND ${m})), ` +
    `(SELECT uniqExact(k) FROM ${r} WHERE ${m}) FORMAT TSV`
}

export interface ChReduceDbOptions {
  /** Rows of the file one slab covers: the keep and proof statements hold one slab of the keys in memory, and a bigger file is done in several slabs. Default 10 million. */
  slabRows?: number
  /** Rows of the file one pass over ulp.credentials looks up (presentSql): a bigger file is looked up in several passes. Default 20 million (about 1.9 GiB at the peak when every key is present, measured). */
  scanRows?: number
}

export function chReduceDb(ch: Ch, opts: ChReduceDbOptions = {}): ReduceDb {
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`
  const table = (role: 't' | 'c' | 'h' | 'r' | 's') => `default.zz_red_${suffix}_${role}`
  const [T, C, H, R, S] = [table('t'), table('c'), table('h'), table('r'), table('s')]
  const made: string[] = []
  const slabRows = opts.slabRows ?? 10_000_000
  const scanRows = opts.scanRows ?? 20_000_000
  let rowCount = -1                     // the rows T holds, asked once; the slabs and the scans are cut by it, and classify and prove use the same slabs
  const rowsOf = async (): Promise<number> => {
    if (rowCount < 0) rowCount = await scalar(`SELECT count() FROM ${T}`)
    return rowCount
  }
  const slabsOf = async (): Promise<number> => Math.max(1, Math.ceil((await rowsOf()) / slabRows))
  const scalar = async (sql: string): Promise<number> => Number((await ch.run(sql)).trim())

  async function create(name: string, ddl: string): Promise<void> {
    await ch.run(ddl)
    made.push(name)
  }

  /** S: the keys the database holds under the file's name. Made once, by whichever of classify and prove comes first. */
  async function ensureStored(name: string): Promise<void> {
    if (made.includes(S)) return
    await create(S, `CREATE TABLE ${S} (k UInt64, c UInt64) ENGINE = MergeTree ORDER BY k`)
    await ch.run(keysOfNameSql(S, name))
  }

  async function* tsv(rows: AsyncIterable<LoadRow[]>, count: { n: number }): AsyncGenerator<string> {
    for await (const batch of rows) {
      count.n += batch.length
      yield rowsToTsv(batch)
    }
  }

  return {
    async loadOriginal(rows) {
      await create(T, scratchDdl(T))
      const count = { n: 0 }
      await ch.insertTsv(`INSERT INTO ${T} (seq, s, e, url, email, password) FORMAT TSV`, tsv(rows, count))
      return count.n
    },

    async classify(name): Promise<ClassifyResult> {
      await create(C, `CREATE TABLE ${C} (k UInt64, mine UInt8, present UInt8) ENGINE = MergeTree ORDER BY k`)
      await create(H, `CREATE TABLE ${H} (k UInt64) ENGINE = MergeTree ORDER BY tuple()`)
      const distinct = await scalar(`SELECT uniqExact(k) FROM ${T}`)
      const slabs = await slabsOf()
      if (distinct > 0) {
        await ensureStored(name)
        const scans = Math.max(1, Math.ceil((await rowsOf()) / scanRows))
        for (let scan = 0; scan < scans; scan++) await ch.run(presentSql(H, T, scans, scan))
        for (let slab = 0; slab < slabs; slab++) await ch.run(holdersSql(C, H, S, slabs, slab))
      }
      const mine = await scalar(`SELECT count() FROM ${C} WHERE mine = 1`)
      const known = await scalar(`SELECT count() FROM ${C} WHERE mine = 0`)

      // The kept spans, slab by slab, through a file: a big file has millions of them.
      const dir = await mkdtemp(join(tmpdir(), 'reduced-keep-'))
      const flat: number[] = []
      try {
        for (let slab = 0; slab < slabs && distinct > 0; slab++) {
          const path = join(dir, `keep-${slab}.tsv`)
          await ch.queryToFile(keepSql(T, C, slabs, slab), path)
          for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
            const tab = line.indexOf('\t')
            flat.push(Number(line.slice(0, tab)), Number(line.slice(tab + 1)))
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      return { keep: Float64Array.from(flat), distinct, mine, known, absent: distinct - mine - known }
    },

    async prove(name, rows): Promise<ProofCounts> {
      // The writer proves a second copy when the first (the compacted one) failed: the reduced rows start afresh, the keys the database holds under the name are the same.
      if (made.includes(R)) { await ch.run(`DROP TABLE IF EXISTS ${R} SYNC`); made.splice(made.indexOf(R), 1) }
      await create(R, scratchDdl(R))
      await ch.insertTsv(`INSERT INTO ${R} (seq, s, e, url, email, password) FORMAT TSV`, tsv(rows, { n: 0 }))
      await ensureStored(name)
      const [dbRows, dbKeys] = (await ch.run(storedSql(S))).trim().split('\t').map(Number)
      const sum = { notParsed: 0, missing: 0, spurious: 0, extraKnown: 0, reducedKeys: 0 }
      const slabs = await slabsOf()
      for (let slab = 0; slab < slabs; slab++) {
        const [notParsed, missing, spurious, extraKnown, reducedKeys] = (await ch.run(proofSql(T, C, R, S, slabs, slab))).trim().split('\t').map(Number)
        sum.notParsed += notParsed; sum.missing += missing; sum.spurious += spurious; sum.extraKnown += extraKnown; sum.reducedKeys += reducedKeys
      }
      return { dbRows, dbKeys, ...sum }
    },

    async cleanup() {
      let failed = 0
      for (const t of made.splice(0).reverse()) {
        try { await ch.run(`DROP TABLE IF EXISTS ${t} SYNC`) } catch { failed++ }
      }
      if (failed > 0) throw new Error(`${failed} scratch table(s) could not be dropped (default.zz_red_${suffix}_*)`)
    },
  }
}
