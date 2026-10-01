import fs from 'fs'
import os from 'os'
import path from 'path'
import { readFileSync } from 'fs'
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { classifyHead, sniffFileKind } from '@/lib/inbox-helpers'

describe('classifyHead', () => {
  test('ZIP local-file, empty-archive and spanned-archive signatures are zip', () => {
    expect(classifyHead(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('zip')
    expect(classifyHead(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]))).toBe('zip')
    expect(classifyHead(Buffer.from([0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0]))).toBe('zip')
  })

  test('"PK" that is not a zip signature is judged as text', () => {
    expect(classifyHead(Buffer.from('PKZIP is a tool\nhttps://a.example:user:pw\n'))).toBe('text')
  })

  test('a ULP-style text body is text, including tabs, CRLF and non-ASCII', () => {
    const body = 'https://site.example/login:user@example.com:pässwörd\r\nandroid://x@com.app:u:p\n\thost.example/path\tuser:pw\n日本語:テスト:パス\n'
    expect(classifyHead(Buffer.from(body))).toBe('text')
  })

  test('a few mis-encoded bytes in otherwise normal text do not disqualify it', () => {
    const head = Buffer.concat([Buffer.from('https://a.example:user:pw\n'.repeat(400)), Buffer.from([0xe9, 0xe8, 0xff]), Buffer.from('b.example:u:p\n'.repeat(50))])
    expect(classifyHead(head)).toBe('text')
  })

  test.each([
    ['a NUL byte (executables, images, office files)', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00])],
    ['a PDF header with binary stream data', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40, 0x01), Buffer.from([0x89, 0xff, 0xd8, 0xfe])])],
    ['mostly undecodable bytes', Buffer.from(Array.from({ length: 4000 }, (_, i) => 0x80 + (i % 0x40)))],
    ['an empty file', Buffer.alloc(0)],
  ])('%s is binary', (_name, head) => {
    expect(classifyHead(head)).toBe('binary')
  })
})

describe('sniffFileKind (real files)', () => {
  let dir: string
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-sniff-')) })
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const write = (name: string, data: Buffer | string) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p }

  test('a Telegram-style name whose "extension" is a date fragment is recognised by its content', async () => {
    const f = write('🐊 TG @CHANNEL - 29.04.2026 - ULP PRIVATE.08', 'https://a.example:user:pw\n'.repeat(100))
    expect(path.extname(f)).toBe('.08')
    expect(await sniffFileKind(f)).toBe('text')
  })

  test('a zip with no .zip name is recognised, and a big file is judged from its first 64 KiB only', async () => {
    const z = write('archive.part1', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200_000, 0x41)]))
    expect(await sniffFileKind(z)).toBe('zip')
    const t = write('late-binary.dat', Buffer.concat([Buffer.from('a.example:u:p\n'.repeat(8000)), Buffer.alloc(10, 0)]))
    expect(await sniffFileKind(t)).toBe('text')
  })

  test('binary content is binary whatever the name says', async () => {
    expect(await sniffFileKind(write('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])))).toBe('binary')
  })

  test('a missing file rejects (the watcher treats that as binary)', async () => {
    await expect(sniffFileKind(path.join(dir, 'nope'))).rejects.toThrow()
  })
})

describe('inbox watcher wiring', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('async function enqueueFile'), source.indexOf('uploadQueue(async'))

  test('an unrecognised name is judged by content only after its size has stopped changing', () => {
    const stable = fn.indexOf('isFileSizeStable(')
    const sniff = fn.indexOf('sniffFileKind(')
    expect(stable).toBeGreaterThan(-1)
    expect(sniff).toBeGreaterThan(stable)
  })

  test('only zip and text content are let through; everything else still goes to failed/', () => {
    expect(fn).toMatch(/kind === 'zip'\) ext = '\.zip'/)
    expect(fn).toMatch(/kind === 'text'\) ext = '\.txt'/)
    expect(fn).toContain('moved to failed/')
    expect(fn).toMatch(/\.catch\(\(\) => 'binary' as const\)/)
  })

  test('the watcher still only looks at the root of inbox/, so files in failed/ are never re-imported by themselves', () => {
    expect(source).toMatch(/depth:\s*0/)
    expect(source).toContain('ignoreInitial: true')
  })
})
