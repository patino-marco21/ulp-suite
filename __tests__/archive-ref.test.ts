import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ARCHIVE_REF_EXT, ArchiveRefError, appArchiveDir, hashingStream, parseArchiveRef, readArchiveRefFile, serializeArchiveRef,
} from '@/lib/archive-ref'

const ID = 'ab12'.repeat(6) // 24 hex characters
const SHA = ID + 'cd34'.repeat(10) // 64 hex characters, starting with the id
const ref = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, id: ID, name: 'some file (1).txt', size: 1234, sha256: SHA, ...over })

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-ref-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('parseArchiveRef', () => {
  it('reads a valid reference', () => {
    expect(parseArchiveRef(ref())).toEqual({ v: 1, id: ID, name: 'some file (1).txt', size: 1234, sha256: SHA })
    expect(ARCHIVE_REF_EXT).toBe('.archiveref')
  })

  it('accepts an empty file (size 0) and ignores fields it does not know', () => {
    expect(parseArchiveRef(ref({ size: 0, extra: 'x' })).size).toBe(0)
  })

  it.each([
    ['not JSON', '{nope', /not valid JSON/],
    ['an array', '[]', /must be a JSON object/],
    ['null', 'null', /must be a JSON object/],
    ['another version', ref({ v: 2 }), /unsupported archive reference version/],
    ['an id that is too short', ref({ id: 'ab12' }), /no valid id/],
    ['an upper-case id', ref({ id: ID.toUpperCase() }), /no valid id/],
    ['a sha256 that is too short', ref({ sha256: SHA.slice(1) }), /no valid sha256/],
    ['a sha256 that does not start with the id', ref({ sha256: 'f'.repeat(64) }), /not the start of its sha256/],
    ['an empty name', ref({ name: '' }), /no valid file name/],
    ['a name with a slash', ref({ name: 'a/b.txt' }), /no valid file name/],
    ['a name with a backslash', ref({ name: 'a\\b.txt' }), /no valid file name/],
    ['a name with a NUL', ref({ name: 'a\0b.txt' }), /no valid file name/],
    ['a name that is too long', ref({ name: 'a'.repeat(256) }), /no valid file name/],
    ['a negative size', ref({ size: -1 }), /no valid size/],
    ['a fractional size', ref({ size: 1.5 }), /no valid size/],
    ['a size that is a string', ref({ size: '12' }), /no valid size/],
  ])('refuses %s', (_label, text, message) => {
    expect(() => parseArchiveRef(text)).toThrow(ArchiveRefError)
    expect(() => parseArchiveRef(text)).toThrow(message)
  })
})

describe('readArchiveRefFile and serializeArchiveRef', () => {
  it('round-trips through a file', () => {
    const p = join(root, 'a.txt.archiveref')
    writeFileSync(p, serializeArchiveRef({ id: ID, name: 'a.txt', size: 5, sha256: SHA }))
    expect(readArchiveRefFile(p)).toEqual({ v: 1, id: ID, name: 'a.txt', size: 5, sha256: SHA })
    expect(serializeArchiveRef({ id: ID, name: 'a.txt', size: 5, sha256: SHA }).endsWith('\n')).toBe(true)
  })

  it('refuses a file that is far too big to be a reference', () => {
    const p = join(root, 'big.archiveref')
    writeFileSync(p, 'x'.repeat(70 * 1024))
    expect(() => readArchiveRefFile(p)).toThrow(/a few hundred bytes/)
  })
})

describe('appArchiveDir', () => {
  it('is /archive in the container unless ULP_ARCHIVE_DIR says otherwise', () => {
    expect(appArchiveDir({} as NodeJS.ProcessEnv)).toBe('/archive')
    expect(appArchiveDir({ ULP_ARCHIVE_DIR: '' } as unknown as NodeJS.ProcessEnv)).toBe('/archive')
    expect(appArchiveDir({ ULP_ARCHIVE_DIR: ' /data/arc ' } as unknown as NodeJS.ProcessEnv)).toBe('/data/arc')
  })
})

describe('hashingStream', () => {
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const parts: Buffer[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts)
  }

  it('passes the bytes through unchanged and knows their sha256 once the stream has ended', async () => {
    const { stream, digest } = hashingStream(Readable.from([Buffer.from('abc'), Buffer.from('def')]))
    expect((await drain(stream)).toString()).toBe('abcdef')
    expect(digest()).toBe(createHash('sha256').update('abcdef').digest('hex'))
  })

  it('counts the bytes that have passed through, for the progress line of the Inbox', async () => {
    const { stream, bytes } = hashingStream(Readable.from([Buffer.from('abc'), Buffer.from('defg')]))
    expect(bytes()).toBe(0)
    const reader = stream.getReader()
    await reader.read()
    expect(bytes()).toBe(3)
    while (!(await reader.read()).done) { /* drain */ }
    expect(bytes()).toBe(7)
  })

  it('refuses to give a digest before the stream was read to its end', async () => {
    const { stream, digest } = hashingStream(Readable.from([Buffer.from('abc'), Buffer.from('def')]))
    const reader = stream.getReader()
    await reader.read()
    expect(() => digest()).toThrow(ArchiveRefError)
    await reader.cancel()
  })
})
