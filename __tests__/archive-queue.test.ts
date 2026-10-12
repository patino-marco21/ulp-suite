import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseArchiveRef } from '@/lib/archive-ref'

const script = new URL('../scripts/pile/archive-queue.cjs', import.meta.url).pathname
const entry = (name: string, idChar: string, size: number) => {
  const sha256 = idChar.repeat(64)
  return { name, id: sha256.slice(0, 24), size, sha256, lines: 1, frames: [], archive_bytes: 1, archive_sha256: 'e'.repeat(64), level: 12, created_at: '2026-10-12T00:00:00Z' }
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'archive-queue-'))
  const lines = [
    entry('a.txt', 'a', 10),
    entry('b.txt', 'b', 20),
    entry('a.txt', 'c', 30), // a newer entry for the same name wins
    entry('tab\tname.txt', 'd', 40), // a name the feeder's tab-separated queue cannot carry
  ].map(e => JSON.stringify(e))
  writeFileSync(join(dir, 'manifest.jsonl'), lines.join('\n') + '\n\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = (...args: string[]) => spawnSync('node', [script, ...args], { encoding: 'utf8' })

describe('archive-queue.cjs', () => {
  it('lists the latest manifest entry of each name as size, name and sha256, and leaves out a name that has a tab in it', () => {
    const r = run('list', dir)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n').sort()).toEqual([`20\tb.txt\t${'b'.repeat(64)}`, `30\ta.txt\t${'c'.repeat(64)}`])
  })

  it('writes a reference that the importer accepts', () => {
    const dest = join(dir, 'a.txt.archiveref')
    const r = run('write', dir, 'a.txt', dest)
    expect(r.status, r.stderr).toBe(0)
    expect(parseArchiveRef(readFileSync(dest, 'utf8'))).toEqual({ v: 1, id: 'c'.repeat(24), name: 'a.txt', size: 30, sha256: 'c'.repeat(64) })
  })

  it('exits 3 and writes nothing for a name that is not archived', () => {
    const dest = join(dir, 'nope.txt.archiveref')
    const r = run('write', dir, 'nope.txt', dest)
    expect(r.status).toBe(3)
    expect(existsSync(dest)).toBe(false)
  })

  it('exits 2 on a usage error and 3 when the manifest cannot be read', () => {
    expect(run().status).toBe(2)
    expect(run('list', join(dir, 'missing')).status).toBe(3)
  })
})
