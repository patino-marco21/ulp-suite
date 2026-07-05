import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher — stability check wiring (mid-write read race)', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports isFileSizeStable from lib/inbox-claim', () => {
    expect(source).toContain('isFileSizeStable')
    expect(source).toMatch(/import\s*\{[^}]*isFileSizeStable[^}]*\}\s*from\s*['"]@\/lib\/inbox-claim['"]/)
  })

  test('defines a named wait-duration constant, not an inline magic number', () => {
    expect(source).toMatch(/const STABILITY_CHECK_WAIT_MS\s*=\s*1_000/)
  })

  test('enqueueFile is async and checks stability before marking a file inFlight', () => {
    const fnStart = source.indexOf('async function enqueueFile')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = source.indexOf('\n}', source.indexOf('uploadQueue(async'))
    const fn = source.slice(fnStart, fnEnd)

    const stabilityCallIdx = fn.indexOf('isFileSizeStable(')
    const inFlightAddIdx   = fn.indexOf('inFlight.add(filename)')
    expect(stabilityCallIdx).toBeGreaterThan(-1)
    expect(inFlightAddIdx).toBeGreaterThan(-1)
    expect(stabilityCallIdx).toBeLessThan(inFlightAddIdx)
  })

  test('reconcile() and forceReconcile() do not block on enqueueFile — fire-and-forget with void', () => {
    const reconcileFn = source.slice(source.indexOf('function reconcile('), source.indexOf('function reconcile(') + 700)
    const forceReconcileFn = source.slice(source.indexOf('export function forceReconcile'), source.indexOf('export function forceReconcile') + 700)
    expect(reconcileFn).toContain('void enqueueFile(filePath)')
    expect(forceReconcileFn).toContain('void enqueueFile(filePath)')
  })
})
