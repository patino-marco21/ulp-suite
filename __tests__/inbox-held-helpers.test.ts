import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getHeld, holdSpooledFile, isSafeFileName, releaseFiles, retryFiles } from '@/lib/inbox-helpers'

let root: string
let held: string
let inbox: string
let spool: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-held-'))
  held = path.join(root, 'inbox', 'held')
  inbox = path.join(root, 'inbox')
  spool = path.join(root, 'spool')
  fs.mkdirSync(spool, { recursive: true })
  fs.mkdirSync(inbox, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const spooled = (body = 'x\n') => {
  const p = path.join(spool, `${Math.random().toString(36).slice(2)}.part`)
  fs.writeFileSync(p, body)
  return p
}

describe('isSafeFileName', () => {
  it('accepts a plain name and refuses anything that could leave the directory', () => {
    expect(isSafeFileName('a b (1).txt')).toBe(true)
    for (const bad of ['', '../x', 'a/b', 'a\\b', '..', 'a..b', 'a\0b']) expect(isSafeFileName(bad), JSON.stringify(bad)).toBe(false)
  })
})

describe('getHeld', () => {
  it('lists the files of the held directory with their sizes, and nothing when it does not exist', () => {
    expect(getHeld(held)).toEqual([])
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(held, 'a.txt'), '12345')
    fs.mkdirSync(path.join(held, 'sub'))
    expect(getHeld(held)).toEqual([{ name: 'a.txt', size_bytes: 5, mtime: expect.any(String) }])
  })
})

describe('releaseFiles', () => {
  it('moves a held file back to the inbox and reports the names it moved', () => {
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(held, 'a.txt'), 'a')
    fs.writeFileSync(path.join(held, 'b.txt'), 'b')
    expect(releaseFiles(['a.txt', 'missing.txt'], held, inbox)).toEqual(['a.txt'])
    expect(fs.existsSync(path.join(inbox, 'a.txt'))).toBe(true)
    expect(fs.existsSync(path.join(held, 'a.txt'))).toBe(false)
    expect(fs.existsSync(path.join(held, 'b.txt'))).toBe(true)
  })

  it('refuses a name that is a path', () => {
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(root, 'secret.txt'), 's')
    expect(releaseFiles(['../../secret.txt', '../secret.txt'], held, inbox)).toEqual([])
    expect(fs.existsSync(path.join(root, 'secret.txt'))).toBe(true)
  })
})

describe('holdSpooledFile', () => {
  it('moves the spooled upload into the held directory under its upload name', () => {
    const p = spooled('payload')
    expect(holdSpooledFile(p, 'upload.txt', held)).toBe('upload.txt')
    expect(fs.readFileSync(path.join(held, 'upload.txt'), 'utf8')).toBe('payload')
    expect(fs.existsSync(p)).toBe(false)
  })

  it('keeps only the base name, so an upload name cannot leave the directory', () => {
    expect(holdSpooledFile(spooled(), '../../etc/passwd', held)).toBe('passwd')
    expect(holdSpooledFile(spooled(), 'C:\\temp\\evil.txt', held)).toBe('evil.txt')
    expect(holdSpooledFile(spooled(), 'a\u0001b.txt', held)).toBe('ab.txt')
    expect(fs.readdirSync(held).sort()).toEqual(['ab.txt', 'evil.txt', 'passwd'])
  })

  it('gives a name that is already held a numbered sibling instead of overwriting it', () => {
    holdSpooledFile(spooled('first'), 'dup.txt', held)
    expect(holdSpooledFile(spooled('second'), 'dup.txt', held)).toBe('dup (2).txt')
    expect(fs.readFileSync(path.join(held, 'dup.txt'), 'utf8')).toBe('first')
    expect(fs.readFileSync(path.join(held, 'dup (2).txt'), 'utf8')).toBe('second')
  })

  it('names a nameless upload', () => {
    const name = holdSpooledFile(spooled(), '..', held)
    expect(name).toMatch(/^upload-\d+\.txt$/)
  })

  it('copies and removes when the spool is on another filesystem (EXDEV)', () => {
    const p = spooled('cross-device')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    })
    expect(holdSpooledFile(p, 'x.txt', held)).toBe('x.txt')
    expect(fs.readFileSync(path.join(held, 'x.txt'), 'utf8')).toBe('cross-device')
    expect(fs.existsSync(p)).toBe(false)
  })

  it('returns null when the spool file is gone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(holdSpooledFile(path.join(spool, 'does-not-exist.part'), 'x.txt', held)).toBeNull()
  })
})

describe('moving a file back to the inbox when the inbox already holds it under the same name', () => {
  it('releaseFiles leaves one name when inbox/ has the held file as another name of the same file', () => {
    fs.mkdirSync(held, { recursive: true })
    fs.writeFileSync(path.join(held, 'a.txt'), 'a')
    fs.linkSync(path.join(held, 'a.txt'), path.join(inbox, 'a.txt'))
    expect(releaseFiles(['a.txt'], held, inbox)).toEqual(['a.txt'])
    expect(fs.existsSync(path.join(held, 'a.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(inbox, 'a.txt'), 'utf8')).toBe('a')
  })

  it('retryFiles moves a failed file back to the inbox and reports it, also over a second name of the same file', () => {
    const failed = path.join(root, 'inbox', 'failed')
    fs.mkdirSync(failed, { recursive: true })
    fs.writeFileSync(path.join(failed, 'a.txt'), 'a')
    fs.writeFileSync(path.join(failed, 'b.txt'), 'b')
    fs.linkSync(path.join(failed, 'b.txt'), path.join(inbox, 'b.txt'))
    expect(retryFiles(['a.txt', 'b.txt', '../x'], failed, inbox)).toEqual(['a.txt', 'b.txt'])
    expect(fs.readdirSync(failed)).toEqual([])
    expect(fs.readFileSync(path.join(inbox, 'a.txt'), 'utf8')).toBe('a')
    expect(fs.readFileSync(path.join(inbox, 'b.txt'), 'utf8')).toBe('b')
  })
})
