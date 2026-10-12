import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = new URL('../', import.meta.url).pathname
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const cleanLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw-${i}-Xy!`
const junkLine = (i: number) => `https://shop${i % 50}.example.test/login:user${i}@mail.test:Pw://x${i}`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'preflight-cli-'))
  writeFileSync(join(root, 'clean.txt'), textOf(3_000, cleanLine))
  writeFileSync(join(root, 'junk.txt'), textOf(3_000, junkLine))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (args: string[]) =>
  spawnSync(TSX, ['scripts/preflight.ts', ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, INGEST_QUALITY_GATE_MIN_LINES: '100' } })

describe('scripts/preflight.ts', () => {
  it('exits 0 for a clean file and prints a PASS line with the numbers', () => {
    const r = run([join(root, 'clean.txt')])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/PASS/)
  })

  it('exits 1 for a file the gate would hold, and says why', () => {
    const r = run([join(root, 'junk.txt')])
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stdout).toMatch(/HOLD/)
    expect(r.stdout).toMatch(/break a rule/)
  })

  it('exits 1 when any one of several files would be held', () => {
    expect(run([join(root, 'clean.txt'), join(root, 'junk.txt')]).status).toBe(1)
  })

  it('--quiet prints one line without the file name; --json prints one object per file', () => {
    const quiet = run(['--quiet', join(root, 'junk.txt')])
    expect(quiet.status).toBe(1)
    expect(quiet.stdout.trim().split('\n')).toHaveLength(1)
    expect(quiet.stdout).not.toContain('junk.txt')
    const json = run(['--json', join(root, 'clean.txt')])
    expect(JSON.parse(json.stdout.trim().split('\n')[0])).toMatchObject({ level: 'pass', whole: true })
  })

  it('exits 2 without a file, and for a file that is neither readable nor archived', () => {
    expect(run([]).status).toBe(2)
    expect(run([join(root, 'does-not-exist.txt')]).status).toBe(2)
  })
})
