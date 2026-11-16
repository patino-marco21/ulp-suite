/**
 * The statements of the ClickHouse side of the reduced archive (lib/reduced-archive-ch.ts) and how many of them it runs. The SQL itself is proven on a real ClickHouse by
 * scripts/e2e-reduced-archive.ts; what is proven here is the shape that keeps memory flat: a file is cut into slabs of keys (`k % slabs = slab`) by the rows its parser read, every
 * statement that holds a set or a join in memory holds only one slab of it, and the counts of the slabs are added up. Measured on a real ClickHouse: before this, the keep
 * statement joined the whole holders table in every slab and the proof built sets of every key, so a file of 20 million rows used 3 GiB and a 4 GiB file would use 7.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Ch } from '@/lib/clickhouse-cli'
import { chReduceDb, holdersSql, keepSql, proofSql, storedSql } from '@/lib/reduced-archive-ch'
import type { LoadRow } from '@/lib/reduced-archive'

/** A Ch that records every statement and answers the few questions the code asks. */
function recordingCh(answers: { rows: number; distinct: number; proof?: string; stored?: string }): Ch & { sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    async run(q: string) {
      sql.push(q)
      if (/SELECT count\(\) FROM default\.zz_red_\w+_t\b/.test(q)) return `${answers.rows}\n`
      if (/SELECT uniqExact\(k\) FROM default\.zz_red_\w+_t\b/.test(q)) return `${answers.distinct}\n`
      if (/SELECT count\(\) FROM default\.zz_red_\w+_c WHERE mine/.test(q)) return '1\n'
      if (/SELECT sum\(c\), count\(\) FROM/.test(q)) return answers.stored ?? '7\t5\n'
      if (/^SELECT \(SELECT/.test(q)) return answers.proof ?? '1\t2\t3\t4\t5\n'
      return ''
    },
    async insertTsv(q: string, rows: AsyncIterable<string | Buffer>) {
      sql.push(q)
      for await (const _ of rows) void _
    },
    async queryToFile(q: string, path: string) {
      sql.push(q)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    },
  }
}

async function* oneRow(): AsyncGenerator<LoadRow[]> {
  yield [{ seq: 0, s: 0, e: 10, url: 'https://a.test', email: 'a@x.test', password: 'pw123456' }]
}

const holderStatements = (sql: string[]) => sql.filter(q => q.startsWith('INSERT INTO') && q.includes('norm_key_hash IN'))
const keepStatements = (sql: string[]) => sql.filter(q => q.startsWith('SELECT f.s, f.e'))
const proofStatements = (sql: string[]) => sql.filter(q => q.startsWith('SELECT (SELECT'))

describe('the slab statements', () => {
  test('keepSql joins only the holders of its own slab', () => {
    const q = keepSql('T', 'C', 6, 4)
    expect(q).toContain('WHERE k % 6 = 4 ORDER BY seq LIMIT 1 BY k')
    expect(q).toContain('LEFT JOIN (SELECT k, mine, present FROM C WHERE k % 6 = 4) AS c ON f.k = c.k')
    expect(q).not.toMatch(/LEFT JOIN C\b/)
  })

  test('holdersSql reads only the keys of its own slab', () => {
    expect(holdersSql('C', 'T', 'a.txt', 6, 4)).toContain('SELECT k FROM T WHERE k % 6 = 4')
  })

  test('every set and every table of the proof is cut to its slab, and nothing is counted outside it', () => {
    const q = proofSql('T', 'C', 'R', 'S', 6, 4)
    // each subquery that builds a set or reads a table carries the slab condition
    const subselects = q.match(/FROM [TCRS]\b[^()]*/g) ?? []
    expect(subselects.length).toBeGreaterThanOrEqual(8)
    for (const part of subselects) expect(part, part).toContain('k % 6 = 4')
    expect(q.endsWith('FORMAT TSV')).toBe(true)
  })

  test('the rows and keys the database holds under the name are asked once, on the whole table', () => {
    expect(storedSql('S')).toBe('SELECT sum(c), count() FROM S FORMAT TSV')
  })
})

describe('chReduceDb slabs', () => {
  test('a file of one slab runs one statement of each kind', async () => {
    const ch = recordingCh({ rows: 5_000_000, distinct: 4_000_000 })
    const db = chReduceDb(ch, { slabRows: 8_000_000 })
    await db.loadOriginal(oneRow())
    await db.classify('a.txt')
    await db.prove('a.txt', oneRow())
    expect(holderStatements(ch.sql)).toHaveLength(1)
    expect(keepStatements(ch.sql)).toHaveLength(1)
    expect(proofStatements(ch.sql)).toHaveLength(1)
    expect(keepStatements(ch.sql)[0]).toContain('k % 1 = 0')
  })

  test('a bigger file is cut by the rows its parser read, not by its distinct keys, and the proof uses the same slabs', async () => {
    const ch = recordingCh({ rows: 48_000_000, distinct: 40_000_000 })
    const db = chReduceDb(ch, { slabRows: 8_000_000 })
    await db.loadOriginal(oneRow())
    await db.classify('a.txt')
    await db.prove('a.txt', oneRow())
    expect(holderStatements(ch.sql)).toHaveLength(6)
    expect(keepStatements(ch.sql)).toHaveLength(6)
    expect(proofStatements(ch.sql)).toHaveLength(6)
    for (let slab = 0; slab < 6; slab++) {
      expect(holderStatements(ch.sql)[slab]).toContain(`k % 6 = ${slab}`)
      expect(keepStatements(ch.sql)[slab]).toContain(`k % 6 = ${slab}`)
      expect(proofStatements(ch.sql)[slab]).toContain(`k % 6 = ${slab}`)
    }
  })

  test('rows are cut on the boundary: one row over a slab makes another', async () => {
    const exact = recordingCh({ rows: 16_000_000, distinct: 15_000_000 })
    const dbA = chReduceDb(exact, { slabRows: 8_000_000 })
    await dbA.loadOriginal(oneRow()); await dbA.classify('a.txt')
    expect(holderStatements(exact.sql)).toHaveLength(2)
    const over = recordingCh({ rows: 16_000_001, distinct: 15_000_000 })
    const dbB = chReduceDb(over, { slabRows: 8_000_000 })
    await dbB.loadOriginal(oneRow()); await dbB.classify('a.txt')
    expect(holderStatements(over.sql)).toHaveLength(3)
  })

  test('the counts of the slabs are added up, and what the database holds is read once', async () => {
    const ch = recordingCh({ rows: 24_000_000, distinct: 20_000_000, proof: '1\t2\t3\t4\t5\n', stored: '70\t50\n' })
    const db = chReduceDb(ch, { slabRows: 8_000_000 })
    await db.loadOriginal(oneRow())
    await db.classify('a.txt')
    const proof = await db.prove('a.txt', oneRow())
    // 3 slabs, each answering notParsed 1, missing 2, spurious 3, extraKnown 4, reducedKeys 5
    expect(proof).toEqual({ dbRows: 70, dbKeys: 50, notParsed: 3, missing: 6, spurious: 9, extraKnown: 12, reducedKeys: 15 })
    expect(ch.sql.filter(q => q.startsWith('SELECT sum(c), count() FROM'))).toHaveLength(1)
  })

  test('an empty file has no slab to run and still proves', async () => {
    const ch = recordingCh({ rows: 0, distinct: 0 })
    const db = chReduceDb(ch)
    await db.loadOriginal((async function* () { /* no rows */ })())
    const cls = await db.classify('a.txt')
    expect(cls.keep.length).toBe(0)
    expect(holderStatements(ch.sql)).toHaveLength(0)
    expect(keepStatements(ch.sql)).toHaveLength(0)
    const proof = await db.prove('a.txt', oneRow())
    expect(proofStatements(ch.sql)).toHaveLength(1)
    expect(proof.dbKeys).toBe(5)
  })

  test('a second proof (the compacted copy failed, the long way is proven next) starts from a fresh table of the reduced rows and does not read the stored keys again', async () => {
    const ch = recordingCh({ rows: 5_000_000, distinct: 4_000_000 })
    const db = chReduceDb(ch, { slabRows: 8_000_000 })
    await db.loadOriginal(oneRow())
    await db.classify('a.txt')
    await db.prove('a.txt', oneRow())
    await db.prove('a.txt', oneRow())
    const creates = (role: string) => ch.sql.filter(q => new RegExp(`^CREATE TABLE default\\.zz_red_\\w+_${role} `).test(q)).length
    expect(creates('r')).toBe(2)
    expect(creates('s')).toBe(1)
    expect(ch.sql.filter(q => /^INSERT INTO default\.zz_red_\w+_s SELECT/.test(q))).toHaveLength(1)
    expect(ch.sql.filter(q => /^DROP TABLE IF EXISTS default\.zz_red_\w+_r SYNC/.test(q))).toHaveLength(1)   // the first one, before the second is made
    expect(proofStatements(ch.sql)).toHaveLength(2)
    await db.cleanup()
    // every table is dropped once more at the end: t, c, r, s
    expect(ch.sql.filter(q => q.startsWith('DROP TABLE IF EXISTS'))).toHaveLength(1 + 4)
  })
})
