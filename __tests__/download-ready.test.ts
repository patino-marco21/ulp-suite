/**
 * "Is this download finished?" (lib/download-ready.ts): a file some process has open is not, a file changed a moment ago is not, a file with holes (an interrupted download) is
 * not. The open-file scan is tested against a REAL second process that holds a file open, and against a fake /proc tree; nothing here reads the owner's folders.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openFilesUnder, readiness } from '@/lib/download-ready'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'download-ready-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const stat = (p: string) => statSync(p, { bigint: true })
const old = (p: string, ageMs = 3_600_000) => { const t = new Date(Date.now() - ageMs); utimesSync(p, t, t) }

describe('openFilesUnder', () => {
  it('sees a file another process holds open, and stops seeing it once that process lets go', async () => {
    const f = join(root, 'big.txt')
    writeFileSync(f, 'x'.repeat(5000))
    // a real child that opens the file for writing and keeps it open until its stdin closes, as the chat client does for the whole download
    const child = spawn(process.execPath, ['-e', `const fs=require('fs');fs.openSync(${JSON.stringify(f)},'a');process.stdout.write('open\\n');process.stdin.resume()`], { stdio: ['pipe', 'pipe', 'inherit'] })
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()))
    const during = openFilesUnder(root)
    expect(during.get(f)).toEqual([child.pid])
    child.stdin.end()
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    expect(openFilesUnder(root).has(f)).toBe(false)
  })

  it('leaves out the caller and files outside the folder, and never throws on a missing folder or /proc', () => {
    const f = join(root, 'mine.txt')
    writeFileSync(f, 'x')
    const fd = openSync(f, 'r')
    try {
      expect(openFilesUnder(root, { excludePid: process.pid }).has(f)).toBe(false)
      expect(openFilesUnder(root).get(f)).toEqual([process.pid])
      expect(openFilesUnder(join(root, 'elsewhere')).size).toBe(0)
      expect(openFilesUnder(root, { procRoot: join(root, 'no-proc') }).size).toBe(0)
    } finally { closeSync(fd) }
  })

  it('reads a /proc-shaped tree: a deleted file does not count, an unreadable process is skipped', () => {
    const proc = join(root, 'proc')
    const dl = join(root, 'dl'); mkdirSync(dl)
    mkdirSync(join(proc, '123', 'fd'), { recursive: true })
    mkdirSync(join(proc, '456', 'fd'), { recursive: true })
    mkdirSync(join(proc, 'self'))
    symlinkSync(join(dl, 'a.txt'), join(proc, '123', 'fd', '5'))
    symlinkSync(join(dl, 'gone.txt') + ' (deleted)', join(proc, '456', 'fd', '5'))
    symlinkSync(join(root, 'other.txt'), join(proc, '456', 'fd', '6'))
    const open = openFilesUnder(dl, { procRoot: proc })
    expect([...open]).toEqual([[join(dl, 'a.txt'), [123]]])
  })
})

describe('readiness', () => {
  const o = (open = new Map<string, number[]>()) => ({ nowMs: Date.now(), quietMs: 180_000, open })

  it('a closed, quiet, fully written file is ready', () => {
    const f = join(root, 'done.txt'); writeFileSync(f, 'y'.repeat(50_000)); old(f)
    expect(readiness(f, stat(f), o())).toEqual({ ready: true })
  })

  it('a file another program has open is still downloading, however long it has been quiet (a stalled network)', () => {
    const f = join(root, 'dl.txt'); writeFileSync(f, 'y'.repeat(50_000)); old(f)
    const r = readiness(f, stat(f), o(new Map([[f, [4242]]])))
    expect(r).toMatchObject({ ready: false, state: 'downloading' })
    expect(r.detail).toMatch(/pid 4242/)
  })

  it('a file changed a moment ago is settling; at the quiet period it is ready', () => {
    const f = join(root, 'new.txt'); writeFileSync(f, 'y'.repeat(50_000))
    expect(readiness(f, stat(f), o())).toMatchObject({ ready: false, state: 'settling' })
    old(f, 181_000)
    expect(readiness(f, stat(f), o()).ready).toBe(true)
  })

  it('a file with holes, as the client leaves when it is killed while parts are still arriving, looks interrupted', () => {
    const f = join(root, 'cut.txt')
    writeFileSync(f, 'head\n')
    truncateSync(f, 8 * 1024 * 1024)   // the rest was never written: a hole
    const fd = openSync(f, 'r+'); ftruncateSync(fd, 8 * 1024 * 1024); closeSync(fd)
    old(f)
    const r = readiness(f, stat(f), o())
    expect(r).toMatchObject({ ready: false, state: 'interrupted' })
    expect(r.detail).toMatch(/never written/)
  })

  it('open is reported before settling: the more useful reason first', () => {
    const f = join(root, 'both.txt'); writeFileSync(f, 'y'.repeat(50_000))
    expect(readiness(f, stat(f), o(new Map([[f, [7]]]))).state).toBe('downloading')
  })
})
