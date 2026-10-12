/** The side copy keeps every line the parser does not store, as raw bytes, compressed. Synthetic files only. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { extractDroppedLines } from '@/lib/dropped-lines'
import { makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'
import { appendManifest, archiveFile } from '@/lib/source-archive'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dropped-lines-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const hardDrop = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3', INGEST_FILTER_HARD_KEEP_COUNTRIES: 'PL' }))

describe('extractDroppedLines', () => {
  test('stores the dropped lines byte for byte (raw bytes, CRLF and Latin-1 included) and counts the rest', async () => {
    const stored = [
      'https://shop.example.test/login:alice@mail.test:Secret1',   // stored
      'https://shop.example.pl/login:pawel:Secret2',               // T3 but a kept country: stored
      'shop.example.test : bob@mail.test : Secret3',               // rule A: stored
    ]
    const droppedText = [
      'https://shop.example.com.br/login:carlos:Secret4',          // T3 outside the keep-list
      'just a banner line',                                        // no fields
      'https://shop.example.test/login:dave@mail.test:ab',         // password too short
    ]
    const latin1Dropped = Buffer.from([...Buffer.from('banner caf'), 0xe9, 0x0d])    // a Latin-1 byte and a CR
    const body = Buffer.concat([
      Buffer.from(stored[0] + '\n'), Buffer.from(droppedText[0] + '\n'), Buffer.from('\n'), Buffer.from(stored[1] + '\r\n'),
      Buffer.from(droppedText[1] + '\n'), latin1Dropped, Buffer.from('\n'), Buffer.from(stored[2] + '\n'), Buffer.from('   \n'), Buffer.from(droppedText[2]),   // no final newline
    ])
    const src = join(dir, 'in.txt'); const out = join(dir, 'in.drop.zst')
    writeFileSync(src, body)

    const stats = await extractDroppedLines(src, out, hardDrop)

    const expected = Buffer.concat([
      Buffer.from(droppedText[0] + '\n'), Buffer.from(droppedText[1] + '\n'), latin1Dropped, Buffer.from('\n'), Buffer.from(droppedText[2] + '\n'),
    ])
    expect(Buffer.compare(zstdDecompressSync(readFileSync(out)), expected)).toBe(0)
    expect(stats.lines).toBe(7)           // blank and white-space-only lines are not counted
    expect(stats.stored).toBe(3)
    expect(stats.dropped).toBe(4)
    expect(stats.reasons).toMatchObject({ tier_dropped: 1, no_fields: 2, no_password: 1 })
    expect(Object.values(stats.reasons).reduce((a, b) => a + b, 0)).toBe(stats.dropped)
    expect(stats.sha256).toBe(createHash('sha256').update(readFileSync(out)).digest('hex'))
    expect(stats.outBytes).toBe(readFileSync(out).length)
  })

  test('a file with nothing to drop leaves an empty (but valid) archive', async () => {
    const src = join(dir, 'clean.txt'); const out = join(dir, 'clean.drop.zst')
    writeFileSync(src, 'https://shop.example.test/login:alice@mail.test:Secret1\n')
    const stats = await extractDroppedLines(src, out, hardDrop)
    expect(stats).toMatchObject({ lines: 1, stored: 1, dropped: 0 })
    expect(zstdDecompressSync(readFileSync(out)).length).toBe(0)
  })
})

describe('extractDroppedLines reads the archive when the original is gone', () => {
  test('a source that exists only in the archive gives the same result', async () => {
    const arcDir = mkdtempSync(join(dir, 'arc-'))
    const body = 'https://shop.example.com.br/login:carlos:Secret4\njust a banner line\n'
    const p = join(dir, 'gone.txt')
    writeFileSync(p, body)
    appendManifest(arcDir, archiveFile(p, { archiveDir: arcDir }))
    rmSync(p)

    const before = process.env.ULP_ARCHIVE_DIR
    process.env.ULP_ARCHIVE_DIR = arcDir
    try {
      const stats = await extractDroppedLines(p, join(dir, 'gone.drop.zst'), hardDrop)
      expect(stats.lines).toBe(2)
      expect(stats.dropped).toBe(2)          // the T3 line outside the keep-list and the banner
      expect(stats.stored).toBe(0)
    } finally {
      if (before === undefined) delete process.env.ULP_ARCHIVE_DIR
      else process.env.ULP_ARCHIVE_DIR = before
    }
  })
})
