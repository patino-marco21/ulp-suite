/**
 * scripts/pile/verify-file.ts run for real against a fake `docker` that logs the SQL it is given and answers the probe from a file. The recount itself
 * (parse, hash, compare with ClickHouse) is proven on the live table after a batch; this pins what the tool asks, how it adds the answers up, and
 * which invariants it checks, without a ClickHouse.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = new URL('../', import.meta.url).pathname
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = 'scripts/pile/verify-file.ts'

const line = (i: number) => `https://shop${i}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
// five distinct credentials and one exact repeat of the first: 6 importable rows, 5 distinct hashes, 1 repeat
const BODY = [0, 1, 2, 3, 4, 0].map(line).join('\n') + '\n'

const FULL_SCHEMA = 'CREATE TABLE processing_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, filename TEXT, status TEXT, imported INTEGER, known INTEGER, skipped INTEGER, duration_ms INTEGER, error_message TEXT, created_at TEXT, repeats INTEGER, note TEXT)'
const OLD_SCHEMA = 'CREATE TABLE processing_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, filename TEXT, status TEXT, imported INTEGER, known INTEGER, skipped INTEGER, duration_ms INTEGER, error_message TEXT, created_at TEXT)'

interface Box { root: string; dbDir: string; bin: string; sqlLog: string; answers: string; counter: string; files: string[] }
let box: Box | undefined
afterEach(() => { if (box) rmSync(box.root, { recursive: true, force: true }); box = undefined })

interface Job { filename: string; status?: string; imported: number; known: number; skipped: number; repeats?: number | null; note?: string | null }

function makeBox(jobs: Job[], opts: { schema?: string; bodies?: Record<string, string> } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'verify-file-'))
  const dbDir = join(root, 'db'), bin = join(root, 'bin'), pile = join(root, 'pile')
  for (const d of [dbDir, bin, pile]) mkdirSync(d, { recursive: true })
  const db = new Database(join(dbDir, 'ulp.db'))
  db.exec(opts.schema ?? FULL_SCHEMA)
  const full = (opts.schema ?? FULL_SCHEMA) === FULL_SCHEMA
  for (const j of jobs) {
    if (full) db.prepare('INSERT INTO processing_jobs (source, filename, status, imported, known, skipped, duration_ms, created_at, repeats, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('inbox', j.filename, j.status ?? 'done', j.imported, j.known, j.skipped, 1000, '2026-10-21 15:00:00', j.repeats ?? null, j.note ?? null)
    else db.prepare('INSERT INTO processing_jobs (source, filename, status, imported, known, skipped, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('inbox', j.filename, j.status ?? 'done', j.imported, j.known, j.skipped, 1000, '2026-10-21 15:00:00')
  }
  db.close()
  const files = jobs.map(j => { const p = join(pile, j.filename); writeFileSync(p, opts.bodies?.[j.filename] ?? BODY); return p })
  const sqlLog = join(root, 'sql.log'), answers = join(root, 'answers.txt'), counter = join(root, 'counter.txt')
  writeFileSync(sqlLog, ''); writeFileSync(answers, ''); writeFileSync(counter, '0')
  // "docker exec [-i] <container> clickhouse-client [options] -q <sql>": the last argument is the SQL. The probe answers one line of "staged, distinct, present, own"
  // per call, from a file (or one fixed line); the partition count and the sources row come from the environment.
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
sql="\${@: -1}"
printf '%s\\n----\\n' "$sql" >> "${sqlLog}"
case "$sql" in
  INSERT*) cat > /dev/null ;;
  *staged_rows*)
    if [ -n "$PROBE_FIXED" ]; then echo "$PROBE_FIXED"; else
      n=$(cat "${counter}"); echo $((n+1)) > "${counter}"; sed -n "$((n+1))p" "${answers}"
    fi ;;
  *"FROM ulp.credentials WHERE _partition_id"*) echo "\${ROWS:-0}" ;;
  *"FROM ulp.sources"*) echo "\${SRC:-0}" ;;
esac
`, { mode: 0o755 })
  return { root, dbDir, bin, sqlLog, answers, counter, files }
}

const run = (b: Box, files: string[], env: Record<string, string> = {}, args: string[] = []) =>
  spawnSync(TSX, [SCRIPT, ...args, b.dbDir, '2026-10-21 00:00:00', ...files], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, PATH: `${b.bin}:${process.env.PATH}`, CH_CONTAINER: 'fake-clickhouse', ROWS: '3', SRC: '3', ...env },
  })
const sql = (b: Box) => readFileSync(b.sqlLog, 'utf8').split('\n----\n').filter(Boolean)
const probes = (b: Box) => sql(b).filter(q => q.includes('staged_rows'))

// three buckets of an answer that adds up: staged 6, distinct 5, present 5 (3 under this file, 2 under others)
const THREE_BUCKETS = '2\t2\t2\t1\n3\t2\t2\t1\n1\t1\t1\t1\n'

describe('scripts/pile/verify-file.ts', () => {
  it('probes the table in buckets of the content hash, each bucket small enough for the memory cap, and adds the answers up', () => {
    box = makeBox([{ filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 1 }])
    writeFileSync(box.answers, THREE_BUCKETS)
    const r = run(box, box.files, { VERIFY_BUCKET_HASHES: '2' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('ALL CHECKS PASSED')
    expect(probes(box)).toHaveLength(3)                                  // 6 importable rows / 2 per bucket
    for (let k = 0; k < 3; k++) {
      const q = probes(box)[k]
      expect(q, `bucket ${k}`).toContain(`h % 3 = ${k}`)                 // the set the table is probed with is one bucket of the hashes
    }
    expect(r.stdout).toMatch(/ok\s+complete\s+every distinct hash is in the table: 5/)
    expect(r.stdout).toMatch(/ok\s+own\s+hashes written under this file == job\.new: 3/)
  })

  it('uses one probe, with no bucket clause, when the file fits one bucket (the default)', () => {
    box = makeBox([{ filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 1 }])
    const r = run(box, box.files, { PROBE_FIXED: '6\t5\t5\t3' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(probes(box)).toHaveLength(1)
    expect(probes(box)[0]).not.toMatch(/ % \d+ = /)
  })

  it('fails when the sums of the buckets disagree with the job', () => {
    box = makeBox([{ filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 1 }])
    writeFileSync(box.answers, '2\t2\t2\t1\n3\t2\t1\t1\n1\t1\t1\t1\n')     // one hash of the file is missing from the table
    const r = run(box, box.files, { VERIFY_BUCKET_HASHES: '2' })
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stdout).toMatch(/FAIL\s+complete/)
  })

  it('checks the rows the job says repeat inside the file against its own offline recount', () => {
    box = makeBox([{ filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 1 }])
    const ok = run(box, box.files, { PROBE_FIXED: '6\t5\t5\t3' })
    expect(ok.stdout).toMatch(/ok\s+repeats\s+rows repeated inside the file \(offline == job\): 1/)
    rmSync(box.root, { recursive: true, force: true })
    box = makeBox([{ filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 2 }])
    const bad = run(box, box.files, { PROBE_FIXED: '6\t5\t5\t3' })
    expect(bad.status).toBe(1)
    expect(bad.stdout).toMatch(/FAIL\s+repeats/)
  })

  it('still works on a copy of the database from before the repeats were recorded, and leaves that check out', () => {
    box = makeBox([{ filename: 'a.txt', imported: 3, known: 2, skipped: 0 }], { schema: OLD_SCHEMA })
    const r = run(box, box.files, { PROBE_FIXED: '6\t5\t5\t3' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/FAIL/)
    expect(r.stdout).toContain('info: in-file repeats = 1')
  })

  it('does not recount a job the same-name check skipped: nothing was imported to count', () => {
    box = makeBox([{ filename: 'a.txt', imported: 0, known: 0, skipped: 0, repeats: 0, note: 'already-imported' }])
    const r = run(box, box.files, { PROBE_FIXED: '0\t0\t0\t0' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('same-name check')
    expect(probes(box)).toHaveLength(0)
  })

  it('--jobs runs several files at once, prints each file as one block, and exits 1 when any file fails', () => {
    box = makeBox([
      { filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 1 },
      { filename: 'b.txt', imported: 3, known: 2, skipped: 0, repeats: 1 },
      { filename: 'c.txt', imported: 9, known: 9, skipped: 0, repeats: 1 },     // does not add up with the fixed answer
    ])
    const r = run(box, box.files, { PROBE_FIXED: '6\t5\t5\t3' }, ['--jobs', '3'])
    expect(r.status, r.stdout + r.stderr).toBe(1)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) expect(r.stdout).toContain(`=== ${name}`)
    expect(r.stdout).toMatch(/1 OF 3 FILES/)
    const blocks = r.stdout.split('=== ').slice(1)
    expect(blocks).toHaveLength(3)
    for (const block of blocks) expect(block.match(/offline parse:/g)).toHaveLength(1)   // a block is never split by another file's lines
  })

  it('--jobs on files that all pass says so and exits 0', () => {
    box = makeBox([
      { filename: 'a.txt', imported: 3, known: 2, skipped: 0, repeats: 1 },
      { filename: 'b.txt', imported: 3, known: 2, skipped: 0, repeats: 1 },
    ])
    const r = run(box, box.files, { PROBE_FIXED: '6\t5\t5\t3' }, ['--jobs', '2'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('ALL CHECKS PASSED (2 files)')
  })
})
