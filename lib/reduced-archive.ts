/**
 * The reduced archive (docs/superpowers/plans/2026-11-15-reduced-archive.md). For an imported file it keeps a second archive entry that holds only the lines that added
 * something: the credentials the file was first to store, the credentials no row holds, and every rejected line nobody has explained. A line another file stored first, a
 * repeat inside the file, a blank separator and a tier-dropped line are proven to carry nothing and are left out. The entry is written beside the whole-file entry, in
 * `<archive>/reduced/` with a manifest of its own, so nothing that reads the whole-file entries can mistake one for the other.
 *
 * Nothing here prints a line of a file.
 */
import { countNewlines } from '@/lib/source-archive'

// ── byte ranges ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The union of byte ranges given as flat `[start0, end0, start1, end1, ...]` lists, as sorted, disjoint, non-touching flat pairs. Empty ranges are dropped. The parser's kept
 * ranges are nearly sorted (a block's range comes when the block closes), so a list that is already sorted skips the sort.
 */
export function normalizeRanges(parts: ArrayLike<number>[]): Float64Array {
  let total = 0
  for (const p of parts) total += p.length
  const flat = new Float64Array(total)
  let at = 0
  for (const p of parts) { for (let i = 0; i < p.length; i++) flat[at++] = p[i] }
  const n = total / 2
  let sorted = true
  for (let i = 1; i < n && sorted; i++) if (flat[2 * i] < flat[2 * i - 2]) sorted = false
  let order: Uint32Array | null = null
  if (!sorted) {
    order = Uint32Array.from({ length: n }, (_, i) => i)
    order.sort((a, b) => flat[2 * a] - flat[2 * b] || flat[2 * a + 1] - flat[2 * b + 1])
  }
  const out = new Float64Array(total)
  let m = 0
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k
    const s = flat[2 * i]
    const e = flat[2 * i + 1]
    if (e <= s) continue
    if (m > 0 && s <= out[m - 1]) { if (e > out[m - 1]) out[m - 1] = e }
    else { out[m++] = s; out[m++] = e }
  }
  return out.subarray(0, m)
}

/**
 * Copies the bytes of `ranges` (from normalizeRanges) out of a stream, in order. A range that does not end in a newline (the last line of a file, or a long line the parser
 * read in pieces) is closed with one, so the range after it cannot glue onto it. Returns the bytes written and the newlines among them. A range that reaches past the end
 * of the stream throws: a short copy would pass for a reduced file.
 */
export async function copyRanges(
  chunks: AsyncIterable<Buffer | Uint8Array>,
  ranges: Float64Array,
  write: (bytes: Buffer) => void,
): Promise<{ bytes: number; lines: number }> {
  const NL = Buffer.from('\n')
  const count = ranges.length / 2
  let offset = 0
  let ri = 0
  let bytes = 0
  let lines = 0
  let lastByte = 10
  for await (const piece of chunks) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece.buffer, piece.byteOffset, piece.length)
    const chunkEnd = offset + chunk.length
    while (ri < count && ranges[2 * ri] < chunkEnd) {
      const from = Math.max(ranges[2 * ri], offset)
      const to = Math.min(ranges[2 * ri + 1], chunkEnd)
      if (to > from) {
        const part = chunk.subarray(from - offset, to - offset)
        write(part)
        bytes += part.length
        lines += countNewlines(part)
        lastByte = part[part.length - 1]
      }
      if (ranges[2 * ri + 1] > chunkEnd) break   // the range goes on in the next chunk
      if (lastByte !== 10) { write(NL); bytes++; lines++; lastByte = 10 }
      ri++
    }
    offset = chunkEnd
    if (ri >= count) break
  }
  if (ri < count) throw new Error(`a kept range reaches past the end of the source (${ranges[2 * ri + 1]} > ${offset})`)
  return { bytes, lines }
}
