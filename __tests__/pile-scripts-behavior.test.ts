/**
 * The pile scripts run for real in a sandbox: a fake pile, a fake repository (inbox + data/ulp.db) and a fake `docker` that logs the SQL it is given.
 * Nothing here touches the real inbox, the real pile or a real ClickHouse. The static checks live in pile-scripts.test.ts.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

const script = (f: string) => new URL(`../scripts/pile/${f}`, import.meta.url).pathname

interface Box { root: string; repo: string; pile: string; work: string; bin: string; sqlLog: string; sources: string; env: NodeJS.ProcessEnv }
let box: Box | undefined
afterEach(() => { if (box) rmSync(box.root, { recursive: true, force: true }); box = undefined })

const JOBS_SCHEMA = 'CREATE TABLE processing_jobs (source TEXT, filename TEXT, status TEXT, imported INTEGER, known INTEGER, skipped INTEGER, duration_ms INTEGER, error_message TEXT, created_at TEXT)'

/** A pile of the given files (name -> body), an empty inbox, an empty ulp.db with the jobs table, and a docker that logs the SQL it gets. */
function makeBox(files: Record<string, string>): Box {
  const root = mkdtempSync(join(tmpdir(), 'pile-scripts-'))
  const repo = join(root, 'repo'), pile = join(root, 'pile'), work = join(root, 'work'), bin = join(root, 'bin')
  for (const d of [join(repo, 'inbox', 'done'), join(repo, 'inbox', 'failed'), join(repo, 'inbox', 'processing'), join(repo, 'data'), pile, work, bin]) mkdirSync(d, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(pile, name), body)
  const db = new Database(join(repo, 'data', 'ulp.db')); db.exec(JOBS_SCHEMA); db.close()
  const sqlLog = join(root, 'sql.log'), sources = join(root, 'sources.txt')
  writeFileSync(sqlLog, ''); writeFileSync(sources, '')
  // "docker exec <container> clickhouse-client [options] -q <sql>": the last argument is the SQL. Logged; the list of imported names comes from a file; an ALTER answers nothing; the rest answers 0.
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
sql="\${@: -1}"
printf '%s\\n' "$sql" >> "${sqlLog}"
case "$sql" in
  "SELECT filename FROM ulp.sources") cat "${sources}" ;;
  ALTER*) ;;
  *) echo 0 ;;
esac
`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ULP_REPO: repo, PILE_DIR: pile, PILE_WORK_DIR: work,
    CH_CONTAINER: 'fake-clickhouse', POLL_SECS: '0.2', FLOOR_GIB: '0', IN_FLIGHT: '2',
  }
  return { root, repo, pile, work, bin, sqlLog, sources, env }
}

const sizes = (n: number) => 'x'.repeat(n)
const inboxTop = (b: Box) => readdirSync(join(b.repo, 'inbox')).filter(n => !['done', 'failed', 'processing'].includes(n))
const sqlLines = (b: Box) => readFileSync(b.sqlLog, 'utf8').split('\n').filter(Boolean)

/** Runs a script and a fake importer side by side: the importer moves each inbox file to `done` (or, for `failName`, to `failed`) after two ticks. */
async function runFeeder(b: Box, env: NodeJS.ProcessEnv, failName?: string): Promise<{ code: number | null; out: string; maxInbox: number }> {
  const child = spawn('bash', [script('feed.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
  const age = new Map<string, number>(); let maxInbox = 0
  const timer = setInterval(() => {
    const top = inboxTop(b); maxInbox = Math.max(maxInbox, top.length)
    for (const name of top) {
      const n = (age.get(name) ?? 0) + 1; age.set(name, n)
      if (n >= 2) renameSync(join(b.repo, 'inbox', name), join(b.repo, 'inbox', name === failName ? 'failed' : 'done', name))
    }
  }, 100)
  const code = await new Promise<number | null>(resolve => {
    const kill = setTimeout(() => { child.kill('SIGKILL') }, 40_000)
    child.on('exit', c => { clearTimeout(kill); resolve(c) })
  })
  clearInterval(timer)
  return { code, out, maxInbox }
}

describe('scripts/pile/feed.sh in a sandbox', () => {
  test('hardlinks every .txt smallest-first, never has more than IN_FLIGHT in the inbox, never touches an original, and completes', async () => {
    box = makeBox({ 'c.txt': sizes(30), 'a.txt': sizes(10), 'b.txt': sizes(20), 'e.txt': sizes(50), 'd.txt': sizes(40), 'notes.md': sizes(5) })
    const before = Object.fromEntries(readdirSync(box.pile).map(n => [n, { ino: statSync(join(box!.pile, n)).ino, body: readFileSync(join(box!.pile, n), 'utf8') }]))
    const { code, out, maxInbox } = await runFeeder(box, box.env)
    expect(code, out).toBe(0)
    expect(out).toContain('START queue=5 files')
    expect(out).toMatch(/COMPLETE all 5 files processed/)
    expect([...out.matchAll(/FEED \d+\/5 [\d.]+ MB (\S+)/g)].map(m => m[1])).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
    expect(maxInbox).toBeLessThanOrEqual(2)
    expect(readdirSync(join(box.repo, 'inbox', 'done')).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
    for (const name of Object.keys(before)) {
      const st = statSync(join(box.pile, name))
      expect(st.ino, name).toBe(before[name].ino)
      expect(readFileSync(join(box.pile, name), 'utf8'), name).toBe(before[name].body)
      if (name.endsWith('.txt')) expect(statSync(join(box.repo, 'inbox', 'done', name)).ino, name).toBe(before[name].ino)   // the done name is a second NAME of the same data
    }
    expect(existsSync(join(box.pile, 'notes.md'))).toBe(true)
  }, 60_000)

  test('a file that lands in inbox/failed stops the feeding (exit 2) and nothing more is linked', async () => {
    box = makeBox({ 'a.txt': sizes(10), 'b.txt': sizes(20), 'c.txt': sizes(30) })
    const { code, out } = await runFeeder(box, { ...box.env, IN_FLIGHT: '1' }, 'a.txt')
    expect(code, out).toBe(2)
    expect(out).toContain('STOP new file(s) in inbox/failed')
    expect([...out.matchAll(/ FEED /g)].length).toBe(1)
    expect(inboxTop(box)).toEqual([])
  }, 60_000)

  test('a name already in ulp.sources or anywhere in the inbox tree is not queued (dry run: nothing is linked)', () => {
    box = makeBox({ 'a.txt': sizes(10), 'b.txt': sizes(20), 'c.txt': sizes(30), 'd.txt': sizes(40) })
    writeFileSync(box.sources, 'a.txt\n')
    writeFileSync(join(box.repo, 'inbox', 'done', 'b.txt'), 'already here')
    const r = spawnSync('bash', [script('feed.sh')], { env: { ...box.env, DRY_RUN: '1' }, encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('START queue=2 files')
    expect(r.stdout).toMatch(/first:[\s\S]*c\.txt/)
    expect(inboxTop(box)).toEqual([])
  })

  test('below the free-space floor it pauses and links nothing', async () => {
    box = makeBox({ 'a.txt': sizes(10), 'b.txt': sizes(20) })
    const child = spawn('bash', [script('feed.sh')], { env: { ...box.env, FLOOR_GIB: '100000000' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; child.stdout.on('data', d => { out += d })
    await new Promise<void>(resolve => { const t = setInterval(() => { if (out.includes('LOW DISK')) { clearInterval(t); resolve() } }, 100); setTimeout(() => { clearInterval(t); resolve() }, 10_000) })
    await new Promise(r => setTimeout(r, 600))
    child.kill('SIGKILL')
    expect(out).toContain('LOW DISK')
    expect(out).not.toContain(' FEED ')
    expect(inboxTop(box)).toEqual([])
  }, 30_000)
})

describe('scripts/pile/reset.sh in a sandbox', () => {
  const CUT = '2026-10-11 21:57:59'
  const run = (b: Box, mode: string, extra: NodeJS.ProcessEnv = {}) => spawnSync('bash', [script('reset.sh'), mode], { env: { ...b.env, CUT, ...extra }, encoding: 'utf8' })
  /** a.txt: a hardlink of the original; b.txt: an independent copy with the same bytes (one link); c.txt: not a pile file;
   *  d.txt: has two links, but to some OTHER file, while the pile holds a different d.txt (the inode guard is what protects it) */
  const withDoneNames = (b: Box) => {
    const done = join(b.repo, 'inbox', 'done')
    writeFileSync(join(b.pile, 'a.txt'), 'AAA'); writeFileSync(join(b.pile, 'b.txt'), 'BBB'); writeFileSync(join(b.pile, 'd.txt'), 'DDD')
    spawnSync('ln', [join(b.pile, 'a.txt'), join(done, 'a.txt')])
    copyFileSync(join(b.pile, 'b.txt'), join(done, 'b.txt'))
    writeFileSync(join(done, 'c.txt'), 'CCC')
    writeFileSync(join(b.root, 'elsewhere.txt'), 'EEE')
    spawnSync('ln', [join(b.root, 'elsewhere.txt'), join(done, 'd.txt')])
    return done
  }

  test('aborts while a file is in flight, before it asks ClickHouse for anything that changes', () => {
    box = makeBox({})
    writeFileSync(join(box.repo, 'inbox', 'busy.txt'), 'x')
    const r = run(box, 'apply')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('ABORT: files are in flight')
    expect(sqlLines(box).filter(l => l.startsWith('ALTER'))).toEqual([])
  })

  test('check reports what it would do and changes nothing', () => {
    box = makeBox({})
    const done = withDoneNames(box)
    const r = run(box, 'check')
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('1 names are hardlinks of pile originals')
    expect(r.stdout).toContain('3 left alone')
    expect(r.stdout).toContain('(check only: nothing changed)')
    expect(readdirSync(done).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
    expect(sqlLines(box).filter(l => l.startsWith('ALTER'))).toEqual([])
  })

  test('apply drops the partition, deletes the sources rows, unlinks only the hardlink names and leaves every original alone', () => {
    box = makeBox({})
    const done = withDoneNames(box)
    const r = run(box, 'apply', { ALL_PILE_NAMES: '1' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const alters = sqlLines(box).filter(l => l.startsWith('ALTER'))
    expect(alters[0]).toBe("ALTER TABLE ulp.credentials DROP PARTITION '202610' SETTINGS max_partition_size_to_drop = 0")
    expect(alters[1]).toContain(`ALTER TABLE ulp.sources DELETE WHERE imported_at >= '${CUT}' OR filename IN (`)
    expect(/filename IN \((.*)\)/.exec(alters[1])?.[1].split(',').sort()).toEqual(["'a.txt'", "'b.txt'", "'d.txt'"])   // every pile name, whatever the directory order
    expect(readdirSync(done).sort()).toEqual(['b.txt', 'c.txt', 'd.txt'])  // only the hardlink-of-the-original name went
    expect(readFileSync(join(box.pile, 'a.txt'), 'utf8')).toBe('AAA')       // the original is intact...
    expect(statSync(join(box.pile, 'a.txt')).nlink).toBe(1)                 // ...and has its data to itself again
    expect(readFileSync(join(box.pile, 'b.txt'), 'utf8')).toBe('BBB')
    expect(readFileSync(join(box.pile, 'd.txt'), 'utf8')).toBe('DDD')
    expect(readFileSync(join(box.root, 'elsewhere.txt'), 'utf8')).toBe('EEE')
  })

  test('never removes the LAST name of any data: with the pile directory misconfigured to be the done directory itself, single-link names stay and every byte survives', () => {
    box = makeBox({})
    const done = withDoneNames(box)
    const r = run(box, 'apply', { PILE_DIR: done })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('2 names are hardlinks of pile originals')     // a.txt and d.txt: they have a second name elsewhere
    expect(readdirSync(done).sort()).toEqual(['b.txt', 'c.txt'])               // b.txt and c.txt have one name each: left alone
    expect(readFileSync(join(done, 'b.txt'), 'utf8')).toBe('BBB')
    expect(readFileSync(join(box.pile, 'a.txt'), 'utf8')).toBe('AAA')          // the other names still hold the bytes of the two that went
    expect(readFileSync(join(box.root, 'elsewhere.txt'), 'utf8')).toBe('EEE')
  })
})

describe('scripts/pile/jobs-summary.cjs', () => {
  test('sums the jobs since a time and lists one line per job on request, never a line of a file', () => {
    box = makeBox({})
    const dir = join(box.root, 'copy'); mkdirSync(dir)
    const db = new Database(join(dir, 'ulp.db')); db.exec(JOBS_SCHEMA)
    const ins = db.prepare('INSERT INTO processing_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ins.run('inbox', 'old.txt', 'done', 5, 5, 5, 60000, null, '2026-10-10 00:00:00')       // before the cut: ignored
    ins.run('inbox', 'a.txt', 'done', 100, 40, 10, 120000, null, '2026-10-12 01:00:00')
    ins.run('inbox', 'b.txt', 'done', 50, 0, 0, 60000, null, '2026-10-12 02:00:00')
    ins.run('inbox', 'c.txt', 'failed', 0, 0, 0, 1000, 'boom', '2026-10-12 03:00:00')
    db.close()
    const summary = spawnSync('node', [script('jobs-summary.cjs'), dir, '2026-10-11 00:00:00'], { encoding: 'utf8' })
    expect(summary.stdout.trim()).toBe('JOBS since 2026-10-11 00:00:00: done=2 failed=1 imported(new)=150 known=40 skipped=10 busy_min=3.0')
    const list = spawnSync('node', [script('jobs-summary.cjs'), dir, '2026-10-11 00:00:00', 'list'], { encoding: 'utf8' })
    expect(list.stdout).toContain('failed new=0 known=0 skipped=0 1.0s c.txt  ERR: boom')
    expect(list.stdout).not.toContain('old.txt')
  })
})
