/**
 * The ClickHouse side of the reduced archive writer (lib/reduced-archive.ts, ReduceDb): four scratch tables in the `default` database, named with a random suffix and
 * dropped again whatever happens, and a handful of statements. Nothing is written to `ulp`.
 *
 *   T  the credentials of the original file as the importer's parser reads them, with their byte span and the normalised key (`k`, the same expression as norm_key_hash)
 *   C  for each distinct key of T that some row holds: whether this file's name is among the holders (`mine`)
 *   R  the credentials of the reduced entry (same shape as T, no spans)
 *   S  the keys the database holds under the file's name, with their row counts
 *
 * A key of T is KEPT when it is `mine` (this file stored it) or in no row at all (`absent`); it is DROPPED when only other files hold it (`known`). Of a key that occurs
 * several times in the file only the first occurrence counts. A key can have several holders (look-alikes stored before the normalised check); it is mine when this file is
 * one of them.
 *
 * Memory: a file is cut into slabs of keys (`k % slabs = slab`), by the rows its parser read, and every statement that holds a set or a join in memory holds one slab of it.
 * Measured on a real ClickHouse: the keep statement joined the whole holders table in every slab and the proof built sets of every key, ~150 bytes a row, so a file of 20 million
 * rows used 3 GiB (the limit of 4 GB failed files over ~1.4 GiB, which hold two thirds of the archive) and a 4 GiB file would use 7 GiB. With slabs of 10 million rows no
 * statement passes ~1.6 GiB, whatever the size of the file; the price is one more pass over ulp.credentials (~50-85 s) for each slab.
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

/** Fills C with the holders of the keys of one slab of T (`k % slabs = slab`). */
export const holdersSql = (c: string, t: string, name: string, slabs: number, slab: number) =>
  `INSERT INTO ${c} SELECT norm_key_hash, max(source_file = ${sqlQuote(name)}), 1 FROM ulp.credentials ` +
  `WHERE norm_key_hash IN (SELECT k FROM ${t} WHERE k % ${slabs} = ${slab}) GROUP BY norm_key_hash`

/** The byte spans of the first occurrence of each key of one slab that is mine or absent, in file order: `start<TAB>end`. The holders joined are those of the slab only. */
export const keepSql = (t: string, c: string, slabs: number, slab: number) =>
  `SELECT f.s, f.e FROM (SELECT k, s, e FROM ${t} WHERE k % ${slabs} = ${slab} ORDER BY seq LIMIT 1 BY k) AS f ` +
  `LEFT JOIN (SELECT k, mine, present FROM ${c} WHERE k % ${slabs} = ${slab}) AS c ON f.k = c.k WHERE c.present = 0 OR c.mine = 1 ORDER BY f.s FORMAT TSV`

export const keysOfNameSql = (s: string, name: string) =>
  `INSERT INTO ${s} SELECT norm_key_hash, count() FROM ulp.credentials WHERE source_file = ${sqlQuote(name)} GROUP BY norm_key_hash`

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
  /** Rows of the file one slab covers: the keys of a slab are looked up in one pass over ulp.credentials, and a bigger file is done in several slabs. Default 10 million. */
  slabRows?: number
}

export function chReduceDb(ch: Ch, opts: ChReduceDbOptions = {}): ReduceDb {
  const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`
  const table = (role: 't' | 'c' | 'r' | 's') => `default.zz_red_${suffix}_${role}`
  const [T, C, R, S] = [table('t'), table('c'), table('r'), table('s')]
  const made: string[] = []
  const slabRows = opts.slabRows ?? 10_000_000
  let slabCount = 0                     // cut by the rows T holds, asked once; classify and prove use the same slabs
  const slabsOf = async (): Promise<number> => {
    if (slabCount === 0) slabCount = Math.max(1, Math.ceil((await scalar(`SELECT count() FROM ${T}`)) / slabRows))
    return slabCount
  }
  const scalar = async (sql: string): Promise<number> => Number((await ch.run(sql)).trim())

  async function create(name: string, ddl: string): Promise<void> {
    await ch.run(ddl)
    made.push(name)
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
      const distinct = await scalar(`SELECT uniqExact(k) FROM ${T}`)
      const slabs = await slabsOf()
      for (let slab = 0; slab < slabs && distinct > 0; slab++) await ch.run(holdersSql(C, T, name, slabs, slab))
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
      if (!made.includes(S)) {
        await create(S, `CREATE TABLE ${S} (k UInt64, c UInt64) ENGINE = MergeTree ORDER BY k`)
        await ch.run(keysOfNameSql(S, name))
      }
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
