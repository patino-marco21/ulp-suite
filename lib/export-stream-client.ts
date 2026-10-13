/**
 * Reads a streamed export in the browser (docs/superpowers/specs/2026-10-13-csv-export-streaming-design.md): keeps the chunks for the file
 * and counts the rows as they arrive. A row is one newline-terminated line; `headerLines` lines (1 for csv, 0 for the others) are not rows.
 * The importer splits on lines, so no field holds a newline; if one ever did the count could only go up, which errs on the safe side of not
 * moving the "since last export" mark.
 */
export interface CountedRead {
  chunks: Uint8Array[]
  rows: number
  bytes: number
}

export async function readCountedStream(
  body: ReadableStream<Uint8Array>,
  headerLines: number,
  onRows?: (rows: number) => void,
  now: () => number = Date.now,
  everyMs = 250,
): Promise<CountedRead> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let newlines = 0
  let bytes = 0
  let last = now()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    bytes += value.length
    for (let i = 0; i < value.length; i++) if (value[i] === 10) newlines++
    if (onRows && now() - last >= everyMs) {
      onRows(Math.max(0, newlines - headerLines))
      last = now()
    }
  }
  const rows = Math.max(0, newlines - headerLines)
  onRows?.(rows)
  return { chunks, rows, bytes }
}
