/**
 * Tests for lib/inbox-claim.ts — the filesystem-atomic claim primitives that
 * stop the inbox watcher from double-processing a file (the cause of the
 * byte-identical duplicate rows + ENOENT rename/open errors).
 *
 * Uses a real temp directory so the atomicity of fs.renameSync is exercised
 * for real, not mocked.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { claimFileForProcessing, sweepProcessingToFailed, isFileSizeStable, moveFile } from '@/lib/inbox-claim'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-claim-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('claimFileForProcessing', () => {
  test('moves an existing file into processing/ and returns its new path', () => {
    const src = path.join(tmp, 'a.txt')
    fs.writeFileSync(src, 'data')
    const proc = path.join(tmp, 'processing')

    const dest = claimFileForProcessing(src, proc)

    expect(dest).toBe(path.join(proc, 'a.txt'))
    expect(fs.existsSync(src)).toBe(false)              // claimed out of inbox
    expect(fs.readFileSync(dest as string, 'utf8')).toBe('data')  // contents intact
  })

  test('returns null when the source file is gone (already claimed/removed)', () => {
    const proc = path.join(tmp, 'processing')
    expect(claimFileForProcessing(path.join(tmp, 'missing.txt'), proc)).toBeNull()
  })

  test('a second claim of the same file returns null — single winner', () => {
    const src = path.join(tmp, 'b.txt')
    fs.writeFileSync(src, 'x')
    const proc = path.join(tmp, 'processing')

    expect(claimFileForProcessing(src, proc)).not.toBeNull()  // first wins
    expect(claimFileForProcessing(src, proc)).toBeNull()      // second skips
  })

  test('creates processing/ if it does not exist yet', () => {
    const src = path.join(tmp, 'c.txt')
    fs.writeFileSync(src, 'x')
    const proc = path.join(tmp, 'nested', 'processing')
    expect(claimFileForProcessing(src, proc)).toBe(path.join(proc, 'c.txt'))
  })
})

describe('sweepProcessingToFailed', () => {
  test('moves leftover processing files to failed/ and returns their names', () => {
    const proc = path.join(tmp, 'processing')
    fs.mkdirSync(proc)
    fs.writeFileSync(path.join(proc, 'x.txt'), '1')
    fs.writeFileSync(path.join(proc, 'y.txt'), '2')
    const fail = path.join(tmp, 'failed')

    const swept = sweepProcessingToFailed(proc, fail).sort()

    expect(swept).toEqual(['x.txt', 'y.txt'])
    expect(fs.existsSync(path.join(fail, 'x.txt'))).toBe(true)
    expect(fs.existsSync(path.join(fail, 'y.txt'))).toBe(true)
    expect(fs.existsSync(path.join(proc, 'x.txt'))).toBe(false)
  })

  test('returns [] when processing/ does not exist', () => {
    expect(sweepProcessingToFailed(path.join(tmp, 'nope'), path.join(tmp, 'failed'))).toEqual([])
  })

  test('ignores subdirectories, only sweeps files', () => {
    const proc = path.join(tmp, 'processing')
    fs.mkdirSync(proc)
    fs.mkdirSync(path.join(proc, 'subdir'))
    fs.writeFileSync(path.join(proc, 'f.txt'), '1')

    expect(sweepProcessingToFailed(proc, path.join(tmp, 'failed'))).toEqual(['f.txt'])
  })
})

describe('isFileSizeStable', () => {
  test('returns true when the file size is unchanged across the wait', async () => {
    const file = path.join(tmp, 'stable.txt')
    fs.writeFileSync(file, 'complete content')
    expect(await isFileSizeStable(file, 10)).toBe(true)
  })

  test('returns false when the file grows during the wait', async () => {
    const file = path.join(tmp, 'growing.txt')
    fs.writeFileSync(file, 'partial')
    setTimeout(() => fs.appendFileSync(file, ' more data'), 5)
    expect(await isFileSizeStable(file, 20)).toBe(false)
  })

  test('returns false when the file is removed during the wait', async () => {
    const file = path.join(tmp, 'vanishing.txt')
    fs.writeFileSync(file, 'data')
    setTimeout(() => fs.unlinkSync(file), 5)
    expect(await isFileSizeStable(file, 20)).toBe(false)
  })

  test('returns false when the file does not exist at all', async () => {
    expect(await isFileSizeStable(path.join(tmp, 'missing.txt'), 10)).toBe(false)
  })
})

// rename(2) between two names of ONE file does nothing and reports success (POSIX), so a plain rename leaves the source name behind. A file that is kept under
// two names (a re-fed file whose earlier copy stayed in held/ or done/) stranded one name in processing/ per import until moveFile finished the job.
describe('moveFile', () => {
  test('moves a file to a new name and removes the old one', () => {
    const src = path.join(tmp, 'a.txt')
    const dest = path.join(tmp, 'b.txt')
    fs.writeFileSync(src, 'data')
    moveFile(src, dest)
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('data')
  })

  test('replaces a different file that already has the destination name, as rename does', () => {
    const src = path.join(tmp, 'a.txt')
    const dest = path.join(tmp, 'b.txt')
    fs.writeFileSync(src, 'new')
    fs.writeFileSync(dest, 'old')
    moveFile(src, dest)
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('new')
  })

  test('when the destination is another name of the same file, the source name goes and the data stays', () => {
    const src = path.join(tmp, 'a.txt')
    const dest = path.join(tmp, 'b.txt')
    fs.writeFileSync(src, 'data')
    fs.linkSync(src, dest)
    moveFile(src, dest)
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('data')
    expect(fs.statSync(dest).nlink).toBe(1)
  })

  test('a file moved onto its own path is left alone', () => {
    const src = path.join(tmp, 'a.txt')
    fs.writeFileSync(src, 'data')
    moveFile(src, src)
    expect(fs.readFileSync(src, 'utf8')).toBe('data')
  })

  test('two paths that reach one directory entry through a symlinked directory leave the file alone', () => {
    const real = path.join(tmp, 'real')
    const alias = path.join(tmp, 'alias')
    fs.mkdirSync(real)
    fs.symlinkSync(real, alias)
    fs.writeFileSync(path.join(real, 'a.txt'), 'data')
    moveFile(path.join(real, 'a.txt'), path.join(alias, 'a.txt'))
    expect(fs.readFileSync(path.join(real, 'a.txt'), 'utf8')).toBe('data')
  })

  test('a missing source throws ENOENT, which the claim turns into "already gone"', () => {
    expect(() => moveFile(path.join(tmp, 'missing.txt'), path.join(tmp, 'b.txt'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })
})

describe('the claim and the sweep with a name that is already kept as a hard link', () => {
  test('claiming a file whose name is already in processing/ as another name of the same file takes it out of the inbox', () => {
    const proc = path.join(tmp, 'processing')
    fs.mkdirSync(proc)
    const src = path.join(tmp, 'd.txt')
    fs.writeFileSync(src, 'data')
    fs.linkSync(src, path.join(proc, 'd.txt'))

    const dest = claimFileForProcessing(src, proc)

    expect(dest).toBe(path.join(proc, 'd.txt'))
    expect(fs.existsSync(src)).toBe(false)   // otherwise the next reconcile pass queues it a second time
    expect(fs.readFileSync(dest as string, 'utf8')).toBe('data')
  })

  test('sweeping a leftover whose name failed/ already holds as the same file leaves one name', () => {
    const proc = path.join(tmp, 'processing')
    const fail = path.join(tmp, 'failed')
    fs.mkdirSync(proc)
    fs.mkdirSync(fail)
    fs.writeFileSync(path.join(fail, 'x.txt'), 'data')
    fs.linkSync(path.join(fail, 'x.txt'), path.join(proc, 'x.txt'))

    expect(sweepProcessingToFailed(proc, fail)).toEqual(['x.txt'])

    expect(fs.existsSync(path.join(proc, 'x.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(fail, 'x.txt'), 'utf8')).toBe('data')
  })
})
