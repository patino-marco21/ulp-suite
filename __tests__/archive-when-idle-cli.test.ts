/**
 * scripts/archive-when-idle.ts run for real in a sandbox: a fake repository with an inbox, an archive directory, and a fake `docker` (the tool's ulp.sources sync is
 * answered by it). Nothing here touches the real inbox, archive or ClickHouse. Synthetic files only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readStatus } from '@/lib/archive-auto'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'archive-when-idle.ts')

interface Box { root: string; inbox: string; done: string; arc: string; env: NodeJS.ProcessEnv }
let box: Box | undefined
afterEach(() => { if (box) rmSync(box.root, { recursive: true, force: true }); box = undefined })

/** `files` are in inbox/done, aged `ageMs`; the inbox folders themselves are aged `quietMs` (when the inbox last changed). */
function makeBox(files: Record<string, string>, { ageMs = 60 * 60_000, quietMs = 60 * 60_000 } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'archive-idle-'))
  const repo = join(root, 'repo'), arc = join(root, 'arc'), bin = join(root, 'bin')
  const inbox = join(repo, 'inbox'), done = join(inbox, 'done')
  for (const d of [done, join(inbox, 'failed'), join(inbox, 'processing'), join(inbox, 'held'), arc, bin]) mkdirSync(d, { recursive: true })
  const when = new Date(Date.now() - ageMs)
  for (const [name, body] of Object.entries(files)) { const p = join(done, name); writeFileSync(p, body); utimesSync(p, when, when) }
  const quiet = new Date(Date.now() - quietMs)
  for (const d of [inbox, done, join(inbox, 'failed'), join(inbox, 'processing'), join(inbox, 'held')]) utimesSync(d, quiet, quiet)
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\ncat > /dev/null\nexit 0\n', { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ULP_ARCHIVE_DIR: arc, ULP_REPO: repo, CH_CONTAINER: 'fake-clickhouse', ULP_ARCHIVE_FREE_MARGIN_BYTES: '0',
    // the run refreshes the plain-text ledger copy too: into the sandbox, never the owner's Desktop
    ULP_LEDGER_FILE: join(root, 'ledger.tsv'), APP_CONTAINER: 'fake-app',
    // and sweeps a download folder: a sandbox one that does not exist unless a test makes it, never the owner's
    ULP_DOWNLOAD_DIR: join(root, 'downloads'),
  }
  return { root, inbox, done, arc, env }
}
const run = (b: Box, args: string[] = [], extra: NodeJS.Dict<string> = {}) =>
  spawnSync(TSX, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env: { ...b.env, ...extra }, timeout: 120_000 })

describe('archive-when-idle', () => {
  test('an idle inbox: archives what is in done/, verifies a sample, writes the account, and removes nothing', () => {
    box = makeBox({ 'a.txt': 'line one\nline two\n', 'b.txt': 'other\n', 'empty.txt': '', 'note.csv': 'x,y\n' })
    const r = run(box)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/2 file\(s\).* in done\/ are not archived: archiving \(no --replace\)/)
    expect(readdirSync(box.done).sort()).toEqual(['a.txt', 'b.txt', 'empty.txt', 'note.csv'])   // plaintext untouched
    expect(readdirSync(box.arc).filter(n => n.endsWith('.zst'))).toHaveLength(2)
    const s = readStatus(box.arc)
    expect(s).toMatchObject({ v: 1, ran: true, archived: 2, failed: 0, verify: { checked: 2, failed: 0 }, ready_files: 2, unarchived_files: 0, other_files: 1, empty_files: 1 })
    expect(s?.ready_bytes).toBe(Buffer.byteLength('line one\nline two\n') + Buffer.byteLength('other\n'))
    expect(r.stdout).toMatch(/Archive: 2 files archived .*2 files are ready to replace.*Nothing is removed without you\./)
    expect(existsSync(join(box.arc, '.auto-archive.lock'))).toBe(false)
    expect(readFileSync(join(box.root, 'ledger.tsv'), 'utf8').startsWith('#kind\tfilename')).toBe(true)   // the run refreshed the plain-text ledger copy, in the sandbox
    expect(r.stdout).toMatch(/\[ledger-export\]/)
  })

  test('a second run with nothing new archives nothing and still refreshes the account', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    expect(run(box).status).toBe(0)
    const first = readStatus(box.arc)
    const second = run(box)
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/nothing new in done\/ to archive/)
    expect(readStatus(box.arc)).toMatchObject({ ran: false, archived: 0, ready_files: 1 })
    expect(Date.parse(readStatus(box.arc)!.at)).toBeGreaterThanOrEqual(Date.parse(first!.at))
  })

  test('a file waiting in the inbox, or something in processing/, means not now', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    writeFileSync(join(box.inbox, 'waiting.txt'), 'w')
    const waiting = run(box)
    expect(waiting.status).toBe(0)
    expect(waiting.stdout).toMatch(/not now: a file is waiting or in flight/)
    expect(readdirSync(box.arc)).toEqual([])
    rmSync(join(box.inbox, 'waiting.txt'))
    writeFileSync(join(box.inbox, 'processing', 'p.txt'), 'p')
    expect(run(box, ['--now']).stdout).toMatch(/not now: a file is waiting or in flight/)   // --now does not skip this
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('an inbox that changed a minute ago waits for the quiet time; --now skips the wait', () => {
    box = makeBox({ 'a.txt': 'x\n' }, { quietMs: 60_000 })
    const r = run(box)
    expect(r.stdout).toMatch(/not now: the inbox changed 1 minutes ago \(a run waits for 20 minutes of quiet\)/)
    expect(readStatus(box.arc)).toBeNull()
    const forced = run(box, ['--now'])
    expect(forced.status).toBe(0)
    expect(readStatus(box.arc)).toMatchObject({ archived: 1 })
  })

  test('a missing archive directory is reported and not created', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const nope = join(box.root, 'nope')
    const r = run(box, [], { ULP_ARCHIVE_DIR: nope })
    expect(r.status).toBe(2)
    expect(r.stdout).toMatch(/archive directory does not exist/)
    expect(existsSync(nope)).toBe(false)
  })

  test('a live lock means another run is going; a stale lock is taken over', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    writeFileSync(join(box.arc, '.auto-archive.lock'), String(process.pid))          // this test process is alive
    expect(run(box).stdout).toMatch(/not now: another run holds the lock/)
    expect(readdirSync(box.arc).filter(n => n.endsWith('.zst'))).toHaveLength(0)
    writeFileSync(join(box.arc, '.auto-archive.lock'), '999999999')                  // no such process
    expect(run(box).status).toBe(0)
    expect(readStatus(box.arc)).toMatchObject({ archived: 1 })
  })

  test('after a failed run the next one waits, unless it is run with --now', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    writeFileSync(join(box.arc, 'auto-archive-status.json'), JSON.stringify({
      v: 1, at: new Date(Date.now() - 60 * 60_000).toISOString(), ran: true, archived: 0, failed: 1, plain_bytes: 0, verify: null,
      ready_files: 0, ready_bytes: 0, unarchived_files: 1, unarchived_bytes: 2, other_files: 0, other_bytes: 0, empty_files: 0, free_bytes: 1,
    }))
    const r = run(box)
    expect(r.stdout).toMatch(/not now: the last run failed 60 minutes ago/)
    expect(readdirSync(box.arc).filter(n => n.endsWith('.zst'))).toHaveLength(0)
    expect(run(box, ['--now']).status).toBe(0)
    expect(readStatus(box.arc)).toMatchObject({ archived: 1, failed: 0 })
  })

  test('every run sweeps the download folder first: a file the ledger does not know is left alone, and the account says so', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const downloads = join(box.root, 'downloads')
    mkdirSync(downloads)
    const p = join(downloads, 'fresh.txt')
    const body = `${'a'.repeat(1_000_000)}\n`   // the sweep looks at files of 1 MB or more
    writeFileSync(p, body)
    const old = new Date(Date.now() - 60 * 60_000); utimesSync(p, old, old)
    const r = run(box, ['--now'], { ULP_STANDIN_SWEEP: '' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/\[stand-in-sweep\] done: 0 swapped, 0 would be, 1 not ingested \(left\)/)
    expect(readFileSync(p, 'utf8')).toBe(body)
  })

  test('ULP_STANDIN_SWEEP=off skips the sweep, and a missing download folder is not an error', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const off = run(box, ['--now'], { ULP_STANDIN_SWEEP: 'off' })
    expect(off.status).toBe(0)
    expect(off.stdout).not.toMatch(/stand-in-sweep/)
    const missing = run(box, ['--now'], { ULP_STANDIN_SWEEP: '' })
    expect(missing.status).toBe(0)
    expect(missing.stdout).toMatch(/\[stand-in-sweep\] no download folder at .*downloads: nothing to sweep/)
  })

  test('the status file is valid JSON the app can read: no partial file is left behind', () => {
    const b = (box = makeBox({ 'a.txt': 'x\n' }))
    run(b)
    expect(readdirSync(b.arc).filter(n => n.endsWith('.part'))).toEqual([])
    expect(() => JSON.parse(readFileSync(join(b.arc, 'auto-archive-status.json'), 'utf8'))).not.toThrow()
  })
})
