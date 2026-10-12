/**
 * The side copy: every line of an original file that the importer does NOT store, kept as raw bytes in a zstd file, so that the 140 GiB of originals can
 * go and a later change of policy or parser can still be applied to what was dropped (the T3 lines outside the keep-list, the rejects).
 *
 * A line is "stored" when parseInlineLine (the same call the stream parser makes for a line on its own) gives a credential. Lines that only the stateful
 * layers of the stream parser store (a label-free url / login / password record, a labeled block) read as dropped here, so the copy can hold a few lines
 * more than the importer rejected; it never holds fewer. Blank and white-space-only lines are not counted and not kept.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import { constants as zlibConstants, createZstdCompress } from 'node:zlib'
import { parseInlineLine } from '@/lib/ulp-parser'
import { repairUtf8Line } from '@/lib/ulp-utf8'

const NEWLINE = Buffer.from('\n')

export interface DropStats {
  lines: number
  stored: number
  dropped: number
  reasons: Record<string, number>
  outBytes: number
  sha256: string
}

export async function extractDroppedLines(
  srcPath: string,
  outPath: string,
  shouldHardDrop?: (email: string, url: string) => boolean,
): Promise<DropStats> {
  const stats: DropStats = { lines: 0, stored: 0, dropped: 0, reasons: {}, outBytes: 0, sha256: '' }
  const zstd = createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } })
  const hash = createHash('sha256')
  zstd.on('data', (b: Buffer) => { hash.update(b); stats.outBytes += b.length })
  const written = pipeline(zstd, createWriteStream(outPath))

  let pending: Buffer[] = []
  let pendingBytes = 0
  const flush = async () => {
    if (pending.length === 0) return
    const buf = Buffer.concat(pending)
    pending = []; pendingBytes = 0
    if (!zstd.write(buf)) await once(zstd, 'drain')
  }
  const handle = (raw: Buffer) => {
    const text = repairUtf8Line(raw.toString('latin1'))
    if (!text.trim()) return
    stats.lines++
    const r = parseInlineLine(text, 'side-copy', shouldHardDrop)
    if (r.credential) { stats.stored++; return }
    stats.dropped++
    const reason = r.reason ?? 'unknown'
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1
    pending.push(raw, NEWLINE)
    pendingBytes += raw.length + 1
  }

  let carry: Buffer = Buffer.alloc(0)
  for await (const chunk of createReadStream(srcPath, { highWaterMark: 4 << 20 })) {
    let buf: Buffer = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    let start = 0
    for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
      handle(buf.subarray(start, nl))
      start = nl + 1
    }
    carry = Buffer.from(buf.subarray(start))
    if (pendingBytes >= 8 << 20) await flush()
  }
  if (carry.length) handle(carry)
  await flush()
  zstd.end()
  await written
  stats.sha256 = hash.digest('hex')
  return stats
}

