/**
 * The claims that let several reducer processes share one archive (lib/reduced-claims.ts): a file is taken by whoever creates its claim first, a claim whose process is gone is
 * taken over, and a process releases only its own. The one lock of the command (reduced/.lock) stays with the coordinator; these files only say who works on which file.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { claimKey, claimsDir, clearClaims, releaseClaim, tryClaim, workerArgs } from '@/lib/reduced-claims'

let box: string
beforeEach(() => { box = mkdtempSync(join(tmpdir(), 'reduced-claims-')) })
afterEach(() => { rmSync(box, { recursive: true, force: true }) })

const dir = () => join(box, 'claims')

describe('claimKey', () => {
  test('is the same for the same name and bytes, and differs when either differs', () => {
    expect(claimKey('a.txt', 'aa')).toBe(claimKey('a.txt', 'aa'))
    expect(claimKey('a.txt', 'aa')).not.toBe(claimKey('a.txt', 'bb'))
    expect(claimKey('a.txt', 'aa')).not.toBe(claimKey('b.txt', 'aa'))
    expect(claimKey('a.txt', 'aa')).toMatch(/^[0-9a-f]{40}$/)   // a file name of its own: nothing of the name (a slash, a dot) reaches the path
  })
  test('the directory is the reduced one of the archive', () => {
    expect(claimsDir('/x/archive')).toBe('/x/archive/reduced/claims')
  })
})

describe('tryClaim', () => {
  test('the first process to ask gets the file and a second, alive, does not', () => {
    expect(tryClaim(dir(), 'k1', { pid: 100, alive: () => true })).toBe(true)
    expect(tryClaim(dir(), 'k1', { pid: 200, alive: () => true })).toBe(false)
    expect(readFileSync(join(dir(), 'k1'), 'utf8')).toBe('100')
  })
  test('a claim whose process is gone is taken over', () => {
    expect(tryClaim(dir(), 'k1', { pid: 100, alive: () => true })).toBe(true)
    expect(tryClaim(dir(), 'k1', { pid: 200, alive: pid => pid !== 100 })).toBe(true)
    expect(readFileSync(join(dir(), 'k1'), 'utf8')).toBe('200')
  })
  test('a claim file that holds no pid (cut short) counts as stale', () => {
    tryClaim(dir(), 'k1', { pid: 100, alive: () => true })
    writeFileSync(join(dir(), 'k1'), '')
    expect(tryClaim(dir(), 'k1', { pid: 200, alive: () => true })).toBe(true)
  })
  test('files are independent', () => {
    expect(tryClaim(dir(), 'k1', { pid: 100, alive: () => true })).toBe(true)
    expect(tryClaim(dir(), 'k2', { pid: 200, alive: () => true })).toBe(true)
    expect(readdirSync(dir()).sort()).toEqual(['k1', 'k2'])
  })
  test('by default the claimant is this process, and it is alive', () => {
    expect(tryClaim(dir(), 'k1')).toBe(true)
    expect(tryClaim(dir(), 'k1')).toBe(false)
    expect(readFileSync(join(dir(), 'k1'), 'utf8')).toBe(String(process.pid))
  })
})

describe('releaseClaim', () => {
  test('removes the claim of its own process', () => {
    tryClaim(dir(), 'k1', { pid: 100, alive: () => true })
    releaseClaim(dir(), 'k1', 100)
    expect(existsSync(join(dir(), 'k1'))).toBe(false)
  })
  test('leaves the claim of another process alone (it was taken over after this one was thought dead)', () => {
    tryClaim(dir(), 'k1', { pid: 200, alive: () => true })
    releaseClaim(dir(), 'k1', 100)
    expect(existsSync(join(dir(), 'k1'))).toBe(true)
  })
  test('a claim that is not there is not an error', () => {
    expect(() => releaseClaim(dir(), 'nothing', 100)).not.toThrow()
  })
})

describe('clearClaims', () => {
  test('removes every claim, and is fine without a directory', () => {
    expect(() => clearClaims(dir())).not.toThrow()
    tryClaim(dir(), 'k1', { pid: 100, alive: () => true })
    tryClaim(dir(), 'k2', { pid: 200, alive: () => true })
    clearClaims(dir())
    expect(existsSync(dir())).toBe(false)
  })
})

describe('workerArgs', () => {
  test('the arguments of a worker are those of the command without --workers and its number', () => {
    expect(workerArgs(['run', '--pilot', '2000', '--workers', '4', '--floor-gib', '160'])).toEqual(['run', '--pilot', '2000', '--floor-gib', '160'])
    expect(workerArgs(['run', '--workers', '3'])).toEqual(['run'])
    expect(workerArgs(['run', '--pilot', '5'])).toEqual(['run', '--pilot', '5'])
  })
})
