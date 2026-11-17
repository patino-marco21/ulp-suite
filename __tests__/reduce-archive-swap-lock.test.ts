/**
 * `scripts/reduce-archive.ts swap --apply` removes whole-file entries, so it must not run while the archive timer's run (scripts/archive-when-idle.ts) is reading or
 * replacing them: that run would see a missing file and report a failure. The swap takes the timer's lock too; a lock whose process is gone is taken over. An empty sandbox
 * archive, no ClickHouse and no owner folders: only the lock behaviour is under test.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { reducedDir } from '@/lib/reduced-archive'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'reduce-archive.ts')

let arc: string
beforeEach(() => { arc = mkdtempSync(join(tmpdir(), 'swap-lock-')); mkdirSync(reducedDir(arc), { recursive: true }) })
afterEach(() => rmSync(arc, { recursive: true, force: true }))

const swap = (...args: string[]) => spawnSync(TSX, [SCRIPT, 'swap', '--out', arc, ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env: process.env })
const timerLock = () => join(arc, '.auto-archive.lock')
const swapLock = () => join(reducedDir(arc), '.lock')

describe('reduce-archive swap and the archive timer', () => {
  test('--apply refuses while the timer\'s run is alive, and changes nothing', () => {
    writeFileSync(timerLock(), String(process.pid))   // this test process is alive
    const r = swap('--apply')
    expect(r.status).toBe(2)
    expect(`${r.stdout}${r.stderr}`).toMatch(/archive timer/)
    expect(existsSync(timerLock())).toBe(true)         // the other run's lock is left as it was
    expect(existsSync(swapLock())).toBe(false)         // and the swap's own lock is not left behind
  })

  test('--apply takes over a lock whose process is gone, and gives both locks back', () => {
    writeFileSync(timerLock(), '999999999')
    const r = swap('--apply')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/swapped 0 of 0/)
    expect(existsSync(timerLock())).toBe(false)
    expect(existsSync(swapLock())).toBe(false)
  })

  test('a dry run does not need the timer\'s lock', () => {
    writeFileSync(timerLock(), String(process.pid))
    const r = swap()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/dry run/)
    expect(existsSync(timerLock())).toBe(true)
  })
})
