/**
 * scripts/refeed-from-archive.ts run for real in a sandbox: an inbox, a real source archive built with archiveFile, a ledger copy. Nothing here touches the owner's inbox,
 * archive or ClickHouse (--no-refresh keeps it off docker). Synthetic content only.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseArchiveRef } from '@/lib/archive-ref'
import { formatLedger, type LedgerRow } from '@/lib/ledger-tools'
import { PARSER_REVISION } from '@/lib/parser-version'
import { appendManifest, archiveFile } from '@/lib/source-archive'

/** The version word in a re-feed name follows the parser: "v6.6" now. */
const V = `v${(PARSER_REVISION / 10).toFixed(1)}`
const VR = V.replace('.', '\\.')
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'refeed-from-archive.ts')

let root: string, inbox: string, arc: string, ledger: string, rows: LedgerRow[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'refeed-cli-'))
  inbox = join(root, 'inbox'); arc = join(root, 'archive'); ledger = join(root, 'ledger.tsv'); rows = []
  for (const d of ['', 'processing', 'done', 'held', 'failed']) mkdirSync(join(inbox, d), { recursive: true })
  mkdirSync(arc)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const args = (extra: string[]) => ['--no-refresh', '--inbox', inbox, '--ledger', ledger, '--archive', arc, '--poll-secs', '0.1', ...extra]
const run = (extra: string[], env: NodeJS.Dict<string> = {}) =>
  spawnSync(TSX, [SCRIPT, ...args(extra)], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } })

/** A file the archive holds and the ledger knows at `revision`. */
function archived(name: string, body: string, revision: number): { sha: string; id: string } {
  const p = join(root, `src-${rows.length}.txt`)
  writeFileSync(p, body)
  const entry = archiveFile(p, { archiveDir: arc, name, lookupById: () => undefined })
  appendManifest(arc, entry)
  const sha = createHash('sha256').update(body).digest('hex')
  rows.push({ kind: 'ledger', filename: name, size: Buffer.byteLength(body), sha256: sha, lines: 3, revision, when: '2026-10-20 10:00:00', archived: true })
  writeFileSync(ledger, formatLedger(rows))
  return { sha, id: entry.id }
}
const body = (tag: string) => Array.from({ length: 200 }, (_, i) => `${tag} row ${i}\n`).join('')
const refs = (dir = '') => readdirSync(join(inbox, dir)).filter(n => n.endsWith('.archiveref')).sort()

describe('scripts/refeed-from-archive.ts', () => {
  test('a dry run lists what it would feed and writes nothing', () => {
    archived('old.txt', body('old'), 50)
    archived('current.txt', body('cur'), PARSER_REVISION)
    const r = run(['--max-revision', '64'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(new RegExp(String.raw`would +old \(refeed ${VR}\)\.txt`))
    expect(r.stdout).not.toMatch(/would +current/)
    expect(r.stdout).toMatch(/1 file\(s\).* to read again from the archive.* 1 already read by the current parser/)
    expect(r.stdout).toMatch(/dry run \(nothing written/)
    expect(refs()).toEqual([])
  })

  test('--apply writes a valid reference named for a re-feed, with the archive id, size and sha256', () => {
    const a = archived('old file.txt', body('old'), 61)
    const r = run(['--apply', '--no-wait'])
    expect(r.status).toBe(0)
    expect(refs()).toEqual([`old file (refeed ${V}).txt.archiveref`])
    const ref = parseArchiveRef(readFileSync(join(inbox, `old file (refeed ${V}).txt.archiveref`), 'utf8'))
    expect(ref).toMatchObject({ v: 1, id: a.id, name: `old file (refeed ${V}).txt`, size: Buffer.byteLength(body('old')), sha256: a.sha })
    expect(readdirSync(join(root, '.pile-work'))).toEqual([])   // no half-written reference is left behind
  })

  test('a second run feeds nothing: the reference is already in the inbox, and after it moved to done/ it is still there', () => {
    archived('old.txt', body('old'), 50)
    expect(run(['--apply', '--no-wait']).status).toBe(0)
    expect(run(['--apply', '--no-wait']).stdout).toMatch(/0 file\(s\).* 1 already in the inbox/)
    renameSync(join(inbox, `old (refeed ${V}).txt.archiveref`), join(inbox, 'done', `old (refeed ${V}).txt.archiveref`))
    const again = run(['--apply', '--no-wait'])
    expect(again.stdout).toMatch(/0 file\(s\).* 1 already in the inbox/)
    expect(refs()).toEqual([])
  })

  test('--only and --limit narrow the set; the smallest file goes first', () => {
    archived('big.txt', body('big').repeat(5), 50)
    archived('small.txt', body('sm'), 50)
    archived('mid.txt', body('mid').repeat(2), 50)
    expect(run(['--only', 'mid']).stdout).toMatch(/1 file\(s\)/)
    const r = run(['--apply', '--no-wait', '--limit', '2'])
    expect(r.status).toBe(0)
    expect(refs()).toEqual([`mid (refeed ${V}).txt.archiveref`, `small (refeed ${V}).txt.archiveref`])
  })

  test('at most --in-flight references wait at once: the next one is written only after the importer took one', async () => {
    archived('a.txt', body('a'), 50)
    archived('b.txt', body('bb'), 50)
    const child = spawn(TSX, [SCRIPT, ...args(['--apply', '--no-wait', '--in-flight', '1'])], { cwd: REPO, env: process.env })
    // listen for the exit from the start: a child that exits before a late listener is attached would never be heard again
    const closed = new Promise<number | null>(res => child.on('close', res))
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    const until = async (cond: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 50)); expect(cond()).toBe(true) }
    await until(() => refs().length === 1)
    expect(refs()).toEqual([`a (refeed ${V}).txt.archiveref`])
    await new Promise(r => setTimeout(r, 600))                 // several polls: the second must still be waiting
    expect(refs()).toEqual([`a (refeed ${V}).txt.archiveref`])
    renameSync(join(inbox, `a (refeed ${V}).txt.archiveref`), join(inbox, 'done', `a (refeed ${V}).txt.archiveref`))   // the importer is done with it
    await until(() => refs().length === 1 && existsSync(join(inbox, `b (refeed ${V}).txt.archiveref`)))
    const code = await closed
    expect(code).toBe(0)
    expect(out).toMatch(new RegExp(String.raw`FEED a \(refeed ${VR}\)\.txt`))
    expect(out).toMatch(new RegExp(String.raw`FEED b \(refeed ${VR}\)\.txt`))
  }, 40_000)

  test('a new file in inbox/failed stops the feeding, kills nothing, and the exit code says so', async () => {
    archived('a.txt', body('a'), 50)
    archived('b.txt', body('bb'), 50)
    const child = spawn(TSX, [SCRIPT, ...args(['--apply', '--no-wait', '--in-flight', '1'])], { cwd: REPO, env: process.env })
    // listen for the exit from the start: a child that exits before a late listener is attached would never be heard again
    const closed = new Promise<number | null>(res => child.on('close', res))
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    const end = Date.now() + 20_000
    while (refs().length < 1 && Date.now() < end) await new Promise(r => setTimeout(r, 50))
    renameSync(join(inbox, `a (refeed ${V}).txt.archiveref`), join(inbox, 'failed', `a (refeed ${V}).txt.archiveref`))
    const code = await closed
    expect(code).toBe(1)
    expect(out).toMatch(/STOP a file landed in inbox\/failed; 1 of 2 fed/)
    expect(refs()).toEqual([])
  }, 40_000)

  test('with the importer done it says where each reference ended up, and a held one is reported, not an error', () => {
    archived('a.txt', body('a'), 50)
    // the "importer": a shell loop that moves whatever it finds to held/ (the quality gate)
    const sh = spawn('bash', ['-c', `for i in $(seq 1 200); do for f in "${inbox}"/*.archiveref; do [ -e "$f" ] && mv "$f" "${inbox}/held/"; done; sleep 0.1; done`])
    try {
      const r = run(['--apply'])
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(new RegExp(String.raw`HELD a \(refeed ${VR}\)\.txt`))
      expect(r.stdout).toMatch(/COMPLETE: 1 of 1 fed; 1 held/)
    } finally { sh.kill() }
  }, 40_000)

  test('no archive manifest, or no inbox, is an error that changes nothing', () => {
    const noArc = spawnSync(TSX, [SCRIPT, '--no-refresh', '--inbox', inbox, '--ledger', ledger, '--archive', join(root, 'nope')], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
    expect(noArc.status).toBe(2)
    expect(noArc.stderr).toMatch(/no archive manifest/)
    const noInbox = spawnSync(TSX, [SCRIPT, '--no-refresh', '--inbox', join(root, 'nope'), '--ledger', ledger, '--archive', arc], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
    expect(noInbox.status).toBe(2)
    expect(noInbox.stderr).toMatch(/inbox folder does not exist/)
  })
})
