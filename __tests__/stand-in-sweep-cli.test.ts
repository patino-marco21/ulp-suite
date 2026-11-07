/**
 * scripts/stand-in-sweep.ts run for real in a sandbox: a download folder, a ledger copy, and a real source archive built with archiveFile. Nothing here touches the owner's
 * folders, archive or ClickHouse (--no-refresh keeps it off docker). Synthetic content only.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { formatLedger, isStandIn, type LedgerRow } from '@/lib/ledger-tools'
import { appendManifest, archiveFile } from '@/lib/source-archive'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'stand-in-sweep.ts')

let root: string, dl: string, arc: string, ledger: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sweep-cli-'))
  dl = join(root, 'downloads'); arc = join(root, 'archive'); ledger = join(root, 'ledger.tsv')
  mkdirSync(dl); mkdirSync(arc)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (args: string[], extra: NodeJS.Dict<string> = {}) =>
  spawnSync(TSX, [SCRIPT, '--no-refresh', '--dir', dl, '--archive', arc, '--ledger', ledger, '--min-size', '1', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...extra },
  })

/** A download that is ingested and archived: the file, its archive entry in the manifest and its ledger row. */
function ingested(name: string, body: string, ageMs = 60 * 60_000): string {
  const p = join(dl, name)
  writeFileSync(p, body)
  const when = new Date(Date.now() - ageMs); utimesSync(p, when, when)
  const entry = archiveFile(p, { archiveDir: arc, name, lookupById: () => undefined })
  appendManifest(arc, entry)
  const row: LedgerRow = { kind: 'ledger', filename: name, size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), lines: 3, revision: 65, when: '2026-11-06 20:00:00', archived: true }
  writeFileSync(ledger, formatLedger([row]))
  return p
}
const body = Array.from({ length: 300 }, (_, i) => `row ${i} of the sample\n`).join('')

describe('scripts/stand-in-sweep.ts', () => {
  test('a dry run says what it would do and changes nothing', () => {
    const p = ingested('a.txt', body)
    const r = run([])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/would swap for a stand-in: a\.txt/)
    expect(r.stdout).toMatch(/dry run \(nothing changed; --apply does it\): 0 swapped, 1 would be/)
    expect(readFileSync(p, 'utf8')).toBe(body)
  })

  test('--apply swaps it: same size and time, no blocks; a second run finds a stand-in and reads nothing', () => {
    const p = ingested('b.txt', body)
    const before = statSync(p, { bigint: true })
    const r = run(['--apply'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/swapped for a stand-in: b\.txt/)
    const after = statSync(p, { bigint: true })
    expect([after.size, after.mtimeNs, after.blocks]).toEqual([before.size, before.mtimeNs, 0n])
    expect(readFileSync(join(root, 'ledger-standins.tsv'), 'utf8')).toMatch(/b\.txt/)
    const again = run(['--apply'])
    expect(again.stdout).toMatch(/0 swapped, 0 would be, 0 not ingested \(left\), 0 ingested but not archived yet \(left\), 0 too young \(left\), 0 changed while read \(left\), 1 already stand-ins, 0 failed; 0 file\(s\) hashed/)
  })

  test('--restore puts the real bytes and the time back', () => {
    const p = ingested('c.txt', body)
    const mtimeNs = statSync(p, { bigint: true }).mtimeNs
    expect(run(['--apply']).status).toBe(0)
    expect(isStandIn(p)).toBe(true)
    const r = run(['--restore', p])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/restored .*c\.txt/)
    expect(readFileSync(p, 'utf8')).toBe(body)
    expect(statSync(p, { bigint: true }).mtimeNs).toBe(mtimeNs)
    expect(readdirSync(dl)).toEqual(['c.txt'])
  })

  test('--restore refuses a path that is not in the registry', () => {
    const p = ingested('d.txt', body)
    const r = run(['--restore', p])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/not in the stand-in registry/)
    expect(readFileSync(p, 'utf8')).toBe(body)
  })

  test('a missing download folder or archive is not an error; a missing ledger copy swaps nothing', () => {
    expect(run([], { }).status).toBe(0)
    const noDir = spawnSync(TSX, [SCRIPT, '--no-refresh', '--dir', join(root, 'nope'), '--archive', arc, '--ledger', ledger], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
    expect(noDir.status).toBe(0)
    expect(noDir.stdout).toMatch(/no download folder at .*nope: nothing to sweep/)
    const noArchive = spawnSync(TSX, [SCRIPT, '--no-refresh', '--dir', dl, '--archive', join(root, 'nope'), '--ledger', ledger], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
    expect(noArchive.status).toBe(0)
    expect(noArchive.stdout).toMatch(/no archive at .*nope: nothing can be swapped/)
    const p = join(dl, 'e.txt'); writeFileSync(p, body)
    const noLedger = run([])
    expect(noLedger.status).toBe(0)
    expect(noLedger.stdout).toMatch(/no ledger copy at .*: nothing is known, nothing is swapped/)
  })
})
