/**
 * scripts/pull-downloads.ts run for real in a sandbox: a download folder, an inbox, an archive, a pipeline folder and a ledger copy. Nothing here touches the owner's folders,
 * archive or ClickHouse (--no-refresh keeps it off docker; a fake `docker` answers the status page's container check). Synthetic content only.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { swapOne } from '@/lib/archive-swap'
import { formatLedger, isStandIn, type LedgerRow } from '@/lib/ledger-tools'
import { appendReduced, reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import { appendManifest, archiveFile } from '@/lib/source-archive'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'pull-downloads.ts')

let root: string, dl: string, repo: string, inbox: string, arc: string, pipe: string, ledger: string, env: NodeJS.ProcessEnv
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pull-cli-'))
  dl = join(root, 'downloads'); repo = join(root, 'repo'); inbox = join(repo, 'inbox'); arc = join(root, 'archive'); pipe = join(root, 'pipeline'); ledger = join(pipe, 'ledger.tsv')
  for (const d of [dl, arc, pipe, ...['', 'processing', 'done', 'held', 'failed'].map(x => join(inbox, x))]) mkdirSync(d, { recursive: true })
  writeFileSync(ledger, formatLedger([]))
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ULP_REPO: repo, ULP_DOWNLOAD_DIR: dl, ULP_ARCHIVE_DIR: arc, ULP_LEDGER_FILE: ledger, ULP_MOVER: '', ULP_STANDIN_SWEEP: '' }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (args: string[] = ['--apply'], extra: NodeJS.Dict<string> = {}) =>
  spawnSync(TSX, [SCRIPT, '--no-refresh', '--min-size', '1', ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...env, ...extra } })
const download = (name: string, body: string, ageMs = 60 * 60_000): string => {
  const p = join(dl, name); writeFileSync(p, body)
  const t = new Date(Date.now() - ageMs); utimesSync(p, t, t)
  return p
}
const inboxTxt = () => readdirSync(inbox).filter(n => n.endsWith('.txt'))
const sha = (b: string): string => createHash('sha256').update(b).digest('hex')
const ledgerRow = (name: string, body: string, o: Partial<LedgerRow> = {}): LedgerRow =>
  ({ kind: 'ledger', filename: name, size: Buffer.byteLength(body), sha256: sha(body), lines: 3, revision: 65, when: '2026-11-06 20:00:00', archived: true, ...o })

describe('scripts/pull-downloads.ts', () => {
  test('moves a finished download into the inbox, leaves a stand-in, and writes the status pages', () => {
    const p = download('one.txt', 'alpha\nbeta\n')
    const before = statSync(p, { bigint: true })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/moved into the inbox, stand-in left: one\.txt/)
    expect(readFileSync(join(inbox, 'one.txt'), 'utf8')).toBe('alpha\nbeta\n')
    const after = statSync(p, { bigint: true })
    expect([after.size, after.mtimeNs, after.blocks]).toEqual([before.size, before.mtimeNs, 0n])
    const state = JSON.parse(readFileSync(join(pipe, 'last-run.json'), 'utf8'))
    expect(state).toMatchObject({ v: 1, ok: true, applied: true, moved: ['one.txt'], failed: [] })
    expect(readdirSync(pipe).sort()).toEqual(expect.arrayContaining(['README.txt', 'STATUS.html', 'STATUS.txt', 'last-run.json', 'ledger.tsv', 'stand-ins.tsv', 'hashes.json']))
    expect(readFileSync(join(pipe, 'STATUS.html'), 'utf8')).toMatch(/<title>ULP Pipeline Status<\/title>/)
    expect(readFileSync(join(pipe, 'STATUS.txt'), 'utf8')).toMatch(/Mover: finished downloads go to the inbox/)
  })

  test('a finished download of bytes the archive holds only as a reduced entry becomes a stand-in (the whole copy was swapped away, the chat service keeps the original)', () => {
    const body = Array.from({ length: 300 }, (_, i) => `https://site${i}.example/x:user${i}@mail${i % 97}.example:pw${i * 7919}`).join('\n') + '\n'
    const p = download('swapped.txt', body)
    const before = statSync(p, { bigint: true })
    const whole = archiveFile(p, { archiveDir: arc, name: 'swapped.txt', lookupById: () => undefined })
    appendManifest(arc, whole)
    const rsrc = join(root, 'reduced-src.txt'); writeFileSync(rsrc, body.split('\n').slice(0, 30).join('\n') + '\n')
    mkdirSync(reducedDir(arc), { recursive: true })
    const e = archiveFile(rsrc, { archiveDir: reducedDir(arc), name: 'swapped.txt' })
    const reduced: ReducedEntry = { ...e, of: { sha256: whole.sha256, size: whole.size, lines: whole.lines }, credentials: 1, kept_lines: e.lines, absent: 0, extra_known: 0, db_rows: 1, db_keys: 1, db_drift: 0, verified_at: '2026-11-16T00:00:00.000Z' }
    appendReduced(arc, reduced)
    expect(swapOne({ archiveDir: arc, item: { whole, reduced, savedBytes: whole.archive_bytes - reduced.archive_bytes } }).ok).toBe(true)
    writeFileSync(ledger, formatLedger([ledgerRow('swapped.txt', body)]))
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/swapped for a stand-in: swapped\.txt/)
    expect(isStandIn(p)).toBe(true)
    const after = statSync(p, { bigint: true })
    expect([after.size, after.mtimeNs, after.blocks]).toEqual([before.size, before.mtimeNs, 0n])
    expect(JSON.parse(readFileSync(join(pipe, 'last-run.json'), 'utf8'))).toMatchObject({ ok: true, swapped: ['swapped.txt'], kept: [], failed: [] })
    expect(inboxTxt()).toEqual([])
  })

  test('a finished download whose name the ledger holds with no size and no hash moves into the inbox as a re-feed copy, so the importer decides by content', () => {
    const body = 'legacy\nlines\n'
    const p = download('legacy.txt', body)
    writeFileSync(ledger, formatLedger([ledgerRow('legacy.txt', body, { size: 0, sha256: '', revision: 50 })]))
    const r = run()
    expect(r.status).toBe(0)
    const moved = inboxTxt()
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatch(/^legacy \(refeed v\d\.\d\)\.txt$/)
    expect(readFileSync(join(inbox, moved[0]), 'utf8')).toBe(body)
    expect(isStandIn(p)).toBe(true)
    expect(JSON.parse(readFileSync(join(pipe, 'last-run.json'), 'utf8'))).toMatchObject({ ok: true, moved: ['legacy.txt'], kept: [] })
  })

  test('without --apply it only says what it would do and writes nothing', () => {
    const p = download('dry.txt', 'x\n')
    const r = run([])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/would be moved into the inbox, stand-in left: dry\.txt/)
    expect(r.stdout).toMatch(/dry run \(nothing changed; --apply does it\): 1 would move/)
    expect(readFileSync(p, 'utf8')).toBe('x\n')
    expect(inboxTxt()).toEqual([])
    expect(readdirSync(pipe)).toEqual(['ledger.tsv'])
  })

  test('a download that changed a moment ago waits for the quiet period (3 minutes by default); --quiet 0 skips the wait', () => {
    const p = download('fresh.txt', 'x\n', 2_000)
    const r = run()
    expect(r.stdout).toMatch(/waiting: fresh\.txt: last changed \d+ s ago/)
    expect(inboxTxt()).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe('x\n')
    expect(JSON.parse(readFileSync(join(pipe, 'last-run.json'), 'utf8')).pending).toEqual([expect.objectContaining({ name: 'fresh.txt', state: 'settling' })])
    expect(run(['--apply', '--quiet', '0']).stdout).toMatch(/moved into the inbox, stand-in left: fresh\.txt/)
  })

  test('does not move a file another process holds open; moves it, whole, after that process lets go', async () => {
    const p = download('streaming.txt', 'first\n')
    const child = spawn(process.execPath, ['-e', `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(p)},'a');process.stdout.write('open\\n');process.stdin.on('data',()=>{fs.writeSync(fd,'second\\n');fs.closeSync(fd);process.exit(0)})`], { stdio: ['pipe', 'pipe', 'inherit'] })
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()))
    const during = run()
    expect(during.stdout).toMatch(/waiting: streaming\.txt: still open in another program \(pid \d+\)/)
    expect(inboxTxt()).toEqual([])
    child.stdin.write('go\n')
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    const t = new Date(Date.now() - 3_600_000); utimesSync(p, t, t)
    expect(run().stdout).toMatch(/moved into the inbox/)
    expect(readFileSync(join(inbox, 'streaming.txt'), 'utf8')).toBe('first\nsecond\n')
  })

  test('ULP_MOVER=off does nothing; a missing download folder is recorded, not an error; a missing inbox is an error', () => {
    const p = download('keep.txt', 'x\n')
    expect(run(['--apply'], { ULP_MOVER: 'off' }).stdout).toMatch(/ULP_MOVER=off/)
    expect(readFileSync(p, 'utf8')).toBe('x\n')
    rmSync(dl, { recursive: true })
    expect(run().status).toBe(0)
    expect(JSON.parse(readFileSync(join(pipe, 'last-run.json'), 'utf8'))).toMatchObject({ ok: true, moved: [] })
    expect(readFileSync(join(pipe, 'STATUS.txt'), 'utf8')).toMatch(/The download folder does not exist/)
    rmSync(inbox, { recursive: true })
    const bad = run()
    expect(bad.status).toBe(1)
  })

  test('a live lock means another run is going; a stale lock is taken over', () => {
    download('a.txt', 'x\n')
    writeFileSync(join(pipe, '.pull.lock'), String(process.pid))
    expect(run().stdout).toMatch(/another run holds the lock/)
    expect(inboxTxt()).toEqual([])
    writeFileSync(join(pipe, '.pull.lock'), '999999999')
    expect(run().stdout).toMatch(/moved into the inbox/)
    expect(readdirSync(pipe)).not.toContain('.pull.lock')
  })
})
