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
import { claimFileForProcessing, sweepProcessingToFailed } from '@/lib/inbox-claim'

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
