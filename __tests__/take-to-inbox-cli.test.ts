/**
 * scripts/take-to-inbox.ts run for real in a sandbox (a download folder, an inbox, a ledger copy and a real source archive built with archiveFile): the stand-in gate must
 * give no holder for bytes that only a reduced entry stands for (stage D), because a stand-in there would replace the only local copy by zeros nothing could restore.
 * Nothing here touches the owner's folders, archive or ClickHouse (--no-refresh keeps it off docker). Synthetic content only.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { swapOne } from '@/lib/archive-swap'
import { formatLedger, isStandIn, type LedgerRow } from '@/lib/ledger-tools'
import { appendReduced, reducedDir, type ReducedEntry } from '@/lib/reduced-archive'
import { appendManifest, archiveFile, type ManifestEntry } from '@/lib/source-archive'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'take-to-inbox.ts')

let root: string, dl: string, inbox: string, arc: string, ledger: string
let rows: LedgerRow[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'take-cli-'))
  dl = join(root, 'downloads'); inbox = join(root, 'inbox'); arc = join(root, 'archive'); ledger = join(root, 'ledger.tsv')
  mkdirSync(dl); mkdirSync(inbox); mkdirSync(arc); mkdirSync(reducedDir(arc), { recursive: true })
  rows = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (args: string[]) =>
  spawnSync(TSX, [SCRIPT, '--no-refresh', '--inbox', inbox, '--archive', arc, '--ledger', ledger, '--min-size', '1', ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: process.env })

const lines = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `https://site${i}.example/${tag}:user${i}@mail${(i * 7919) % 997}.example:pw${(i * 104729) % 100003}${tag}`).join('\n') + '\n'

/** A download that is ingested and archived whole: the file, its archive entry in the manifest and its ledger row. */
function ingested(name: string, body: string): { path: string; whole: ManifestEntry } {
  const path = join(dl, name)
  writeFileSync(path, body)
  const when = new Date(Date.now() - 60 * 60_000); utimesSync(path, when, when)
  const whole = archiveFile(path, { archiveDir: arc, name, lookupById: () => undefined })
  appendManifest(arc, whole)
  rows.push({ kind: 'ledger', filename: name, size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), lines: 3, revision: 65, when: '2026-11-06 20:00:00', archived: true })
  writeFileSync(ledger, formatLedger(rows))
  return { path, whole }
}

/** The reduced twin of `whole`, then the swap itself (the manifest line, the whole file removed). */
function swap(whole: ManifestEntry, reducedText: string): void {
  const src = join(root, `red-${whole.name}`)
  writeFileSync(src, reducedText)
  const e = archiveFile(src, { archiveDir: reducedDir(arc), name: whole.name })
  rmSync(src)
  const reduced: ReducedEntry = {
    ...e, of: { sha256: whole.sha256, size: whole.size, lines: whole.lines }, credentials: 1, kept_lines: e.lines, absent: 0, extra_known: 0,
    db_rows: 1, db_keys: 1, db_drift: 0, verified_at: '2026-11-16T00:00:00.000Z',
  }
  appendReduced(arc, reduced)
  const out = swapOne({ archiveDir: arc, item: { whole, reduced, savedBytes: whole.archive_bytes - reduced.archive_bytes } })
  expect(out.ok).toBe(true)
}

describe('scripts/take-to-inbox.ts', () => {
  test('a download of bytes the archive holds whole becomes a stand-in', () => {
    const body = lines(300, 'w')
    const { path } = ingested('whole.txt', body)
    const r = run([path, '--apply'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/stand-in whole\.txt/)
    expect(isStandIn(path)).toBe(true)
  })

  test('a download of bytes that were swapped for a reduced entry stays a real file: a stand-in would be the only local copy turned into zeros', () => {
    const body = lines(300, 's')
    const { path, whole } = ingested('swapped.txt', body)
    swap(whole, lines(30, 's'))
    const before = statSync(path, { bigint: true })
    const r = run([path, '--apply'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/keep\s+swapped\.txt/)
    expect(r.stdout).toMatch(/0 swapped for a stand-in, 1 kept/)
    expect(isStandIn(path)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(body)
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs)
  })
})
