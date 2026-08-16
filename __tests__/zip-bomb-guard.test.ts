import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import type yauzl from 'yauzl'
import {
  processZipEntries,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ZIP_COMPRESSION_RATIO,
  MIN_RATIO_CHECK_BYTES,
  type ProcessResult,
} from '@/lib/upload-processor'

type FakeEntry = Pick<yauzl.Entry, 'fileName' | 'uncompressedSize' | 'compressedSize'>

/**
 * Minimal fake of yauzl's ZipFile — an EventEmitter driven by readEntry(),
 * emitting one 'entry' per queued fake entry, then 'end'. openReadStream
 * always hands back a stream error (routed through the existing, already-
 * tested skipEntry path) so these tests stay isolated to the guard logic in
 * processZipEntries — no real zip bytes or real ULP text content involved.
 */
function fakeZipFile(entries: FakeEntry[]): { zipfile: yauzl.ZipFile; opened: string[] } {
  const ee = new EventEmitter()
  const opened: string[] = []
  let idx = 0

  const zipfile = Object.assign(ee, {
    readEntry() {
      if (idx >= entries.length) {
        queueMicrotask(() => ee.emit('end'))
        return
      }
      const entry = entries[idx++]
      queueMicrotask(() => ee.emit('entry', entry))
    },
    openReadStream(entry: yauzl.Entry, cb: (err: Error | null, stream: never) => void) {
      opened.push(entry.fileName)
      queueMicrotask(() => cb(new Error('fake stream — test only, never actually opened'), undefined as never))
    },
    close() {},
  }) as unknown as yauzl.ZipFile

  return { zipfile, opened }
}

describe('zip decompression-bomb guards (lib/upload-processor.ts processZipEntries)', () => {
  it('skips an entry whose uncompressedSize exceeds the per-entry cap, without ever opening it, and continues to the next entry', async () => {
    const { zipfile, opened } = fakeZipFile([
      { fileName: 'bomb.txt', uncompressedSize: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1, compressedSize: 1_000 },
      { fileName: 'normal.txt', uncompressedSize: 100, compressedSize: 80 },
    ])
    const results: ProcessResult[] = []
    await processZipEntries(zipfile, r => results.push(r))

    expect(opened).not.toContain('bomb.txt')
    expect(opened).toContain('normal.txt') // guard didn't block the next entry
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ filename: 'bomb.txt', errors: 1, imported: 0 })
    // The reason must actually be visible to the admin (not just console.error'd
    // and lost) — this is what app/api/upload/route.ts's failedEntries surfaces.
    expect(results[0].error_reason).toMatch(/uncompressed size .* exceeds .*-byte cap/)
  })

  it('skips an entry whose compression ratio exceeds the cap, without ever opening it', async () => {
    const uncompressedSize = MIN_RATIO_CHECK_BYTES * 2
    const compressedSize = Math.floor(uncompressedSize / (MAX_ZIP_COMPRESSION_RATIO + 50))
    const { zipfile, opened } = fakeZipFile([
      { fileName: 'high-ratio.txt', uncompressedSize, compressedSize },
    ])
    const results: ProcessResult[] = []
    await processZipEntries(zipfile, r => results.push(r))

    expect(opened).not.toContain('high-ratio.txt')
    expect(results).toEqual([expect.objectContaining({ filename: 'high-ratio.txt', errors: 1 })])
    expect(results[0].error_reason).toMatch(/compression ratio .* exceeds .* cap \(possible zip bomb\)/)
  })

  it('does not flag a small entry even with a high nominal ratio (below the absolute floor)', async () => {
    // 50 bytes -> 5000 bytes is a 100:1 ratio, comfortably under
    // MAX_ZIP_COMPRESSION_RATIO, but uncompressedSize is also far below
    // MIN_RATIO_CHECK_BYTES — either guard alone should already pass this.
    const { zipfile, opened } = fakeZipFile([
      { fileName: 'tiny.txt', uncompressedSize: 5_000, compressedSize: 50 },
    ])
    await processZipEntries(zipfile, () => {})
    expect(opened).toContain('tiny.txt')
  })

  it('does not flag a normal large entry with an ordinary compression ratio', async () => {
    // Comfortably above MIN_RATIO_CHECK_BYTES, but only a realistic ~5:1
    // text-compression ratio — must not be treated as a bomb.
    const uncompressedSize = MIN_RATIO_CHECK_BYTES * 5
    const { zipfile, opened } = fakeZipFile([
      { fileName: 'big-legit.txt', uncompressedSize, compressedSize: Math.floor(uncompressedSize / 5) },
    ])
    await processZipEntries(zipfile, () => {})
    expect(opened).toContain('big-legit.txt')
  })

  it('rejects the whole archive once entry count exceeds the cap, without opening entries past the cap', async () => {
    // Directory entries (trailing '/') return via the existing early skip,
    // before openReadStream/skipEntry/console.error — cheap and quiet enough
    // to generate MAX_ZIP_ENTRIES + 5 of them. entriesSeen increments for
    // every 'entry' event regardless of type, so this still exercises the
    // count cap itself, just without the unrelated per-file machinery.
    const entries: FakeEntry[] = Array.from({ length: MAX_ZIP_ENTRIES + 5 }, (_, i) => ({
      fileName: `dir${i}/`,
      uncompressedSize: 0,
      compressedSize: 0,
    }))
    const { zipfile, opened } = fakeZipFile(entries)

    await expect(processZipEntries(zipfile, () => {})).rejects.toThrow(/exceeds .* entries/i)
    expect(opened).toHaveLength(0)
  })
})
