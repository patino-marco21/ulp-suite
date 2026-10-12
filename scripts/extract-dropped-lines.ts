/**
 * Side copy of everything the importer does not store (lib/dropped-lines.ts), for a whole directory of original files. Read-only on the originals.
 *
 *   nice -n 19 npx tsx scripts/extract-dropped-lines.ts --src "$HOME/Downloads/AyuGram Desktop" --out /path/with/room [--workers 8] [--only a.txt,b.txt] [--limit N]
 *
 * One `<index>-<sha1 of the name>.drop.zst` per original plus `manifest.jsonl` (name, size, counts per reason, output bytes, sha256 of the output).
 * The policy is the importer's: INGEST_FILTER_HARD_DROP_TIERS (default T3) and INGEST_FILTER_HARD_KEEP_COUNTRIES (default: the 15 wealthy T3 countries).
 * Expect ~415M lines and 5-9 GiB for the pile, about 40 minutes on 8 cores. Never prints a line of the files.
 */
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setPriority } from 'node:os'
import { extractDroppedLines } from '@/lib/dropped-lines'
import { DEFAULT_HARD_KEEP_COUNTRIES, makeHardDropPredicate, parseIngestPolicy } from '@/lib/ingest-filter'

const args = process.argv.slice(2)
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const policy = parseIngestPolicy({
  INGEST_FILTER_HARD_DROP_TIERS: process.env.INGEST_FILTER_HARD_DROP_TIERS ?? 'T3',
  INGEST_FILTER_HARD_KEEP_COUNTRIES: process.env.INGEST_FILTER_HARD_KEEP_COUNTRIES ?? DEFAULT_HARD_KEEP_COUNTRIES,
})
const hardDrop = makeHardDropPredicate(policy)

async function main(): Promise<void> {
  if (args.includes('--worker')) {
    try { setPriority(19) } catch { /* best effort */ }
    process.on('message', async (job: { src: string; out: string; name: string }) => {
      const stats = await extractDroppedLines(job.src, job.out, hardDrop)
      process.send?.({ name: job.name, stats })
    })
  } else {
    const src = flag('src')
    const out = flag('out')
    if (!src || !out) { console.error('usage: extract-dropped-lines.ts --src <dir> --out <dir> [--workers 8] [--only a,b] [--limit N]'); process.exit(2) }
    mkdirSync(out, { recursive: true })
    const only = flag('only')?.split(',')
    let names = readdirSync(src).filter(n => n.toLowerCase().endsWith('.txt') && (!only || only.includes(n))).sort()
    const limit = Number(flag('limit', '0'))
    if (limit > 0) names = names.slice(0, limit)
    const manifest = join(out, 'manifest.jsonl')
    if (!existsSync(manifest)) writeFileSync(manifest, '')
    const done = new Set(readFileLines(manifest).map(l => JSON.parse(l).name as string))
    const todo = names.filter(n => !done.has(n))
    console.error(`${names.length} files, ${done.size} already done, ${todo.length} to do`)

    const workers = Math.max(1, Number(flag('workers', '8')))
    let next = 0, finished = 0
    const totals = { lines: 0, stored: 0, dropped: 0, outBytes: 0 }
    const start = Date.now()
    await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, () => new Promise<void>(resolve => {
      const w = fork(process.argv[1], ['--worker'], { execArgv: process.execArgv })
      const feed = () => {
        if (next >= todo.length) { w.kill(); resolve(); return }
        const index = names.indexOf(todo[next]); const name = todo[next++]
        const outFile = join(out, `${String(index).padStart(3, '0')}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}.drop.zst`)
        w.send({ src: join(src, name), out: outFile, name })
        w.once('message', (m: { name: string; stats: { lines: number; stored: number; dropped: number; outBytes: number } & Record<string, unknown> }) => {
          appendFileSync(manifest, JSON.stringify({ name, size: statSync(join(src, name)).size, out: outFile, ...m.stats }) + '\n')
          totals.lines += m.stats.lines; totals.stored += m.stats.stored; totals.dropped += m.stats.dropped; totals.outBytes += m.stats.outBytes
          console.error(`[${++finished}/${todo.length}] ${((Date.now() - start) / 60000).toFixed(1)} min  lines ${totals.lines}  dropped ${totals.dropped}  out ${(totals.outBytes / 1073741824).toFixed(2)} GiB`)
          feed()
        })
      }
      feed()
    })))
    console.error(`done: ${JSON.stringify(totals)}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })

function readFileLines(path: string): string[] {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
