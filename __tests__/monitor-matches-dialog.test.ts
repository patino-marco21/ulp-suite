/**
 * Tests components/monitor-matches-dialog.tsx's freshness header and
 * "Rescan now" button (Task 11) — the five new props consumed from
 * useMonitorMatches()'s cache-freshness state (Task 10): checkedAt,
 * neverScanned, lastError, rescanning, and the onRescan callback. Source-text
 * style, matching __tests__/use-monitor-matches.test.ts's and
 * __tests__/monitor-matches-shared.test.ts's convention: this project's
 * Vitest runs in a node environment (see vitest.config.ts) with none of
 * @testing-library/react, jsdom, happy-dom, or react-test-renderer
 * installed, so there is no way to actually render this component. These
 * assertions pin the source-level facts a behavioral test would otherwise
 * check.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('monitor-matches-dialog.tsx — source shape', () => {
  const source = readFileSync(new URL('../components/monitor-matches-dialog.tsx', import.meta.url), 'utf8')

  test('accepts the new freshness/rescan props', () => {
    expect(source).toMatch(/checkedAt/)
    expect(source).toMatch(/neverScanned/)
    expect(source).toMatch(/lastError/)
    expect(source).toMatch(/rescanning/)
    expect(source).toMatch(/onRescan/)
  })

  test('no longer claims results are "queried live"', () => {
    expect(source).not.toMatch(/queried live/)
  })

  test('renders a rescan trigger', () => {
    expect(source).toMatch(/Rescan now/)
  })

  test('never-scanned state is distinguished from a genuinely empty result set', () => {
    expect(source).toMatch(/Not yet scanned/)
  })

  test('the error-before-empty branch order is preserved (existing invariant)', () => {
    const errorIdx = source.indexOf('error ?')
    const emptyIdx = source.indexOf('matches.length === 0')
    expect(errorIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(-1)
    expect(errorIdx).toBeLessThan(emptyIdx)
  })

  // The brief's five tests above pin the required strings; these add the
  // structural rigor __tests__/use-monitor-matches.test.ts established for
  // Task 10 — not just "does this string exist somewhere", but where and how.

  test('never-scanned branch sits between the error branch and the empty-matches branch', () => {
    // Three-way render-order invariant: a failed fetch must outrank
    // "not yet scanned", which must itself outrank "genuinely zero rows" —
    // collapsing any of these into the wrong order produces a false
    // negative (e.g. "No current matches" for a monitor that errored, or
    // for one that has simply never been scanned).
    const errorIdx = source.indexOf('error ?')
    const neverScannedIdx = source.indexOf('neverScanned ?')
    const emptyIdx = source.indexOf('matches.length === 0')
    expect(errorIdx).toBeGreaterThan(-1)
    expect(neverScannedIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(-1)
    expect(errorIdx).toBeLessThan(neverScannedIdx)
    expect(neverScannedIdx).toBeLessThan(emptyIdx)
  })

  test('imports formatRelativeTime from the shared lib rather than reimplementing it', () => {
    expect(source).toMatch(/import\s*\{\s*formatRelativeTime\s*\}\s*from\s*["']@\/lib\/format-relative-time["']/)
  })

  test('checkedAt is rendered through formatRelativeTime, not as a raw/ISO string', () => {
    expect(source).toMatch(/formatRelativeTime\(checkedAt\)/)
  })

  test('the Rescan button is disabled while a rescan or an initial load is in flight', () => {
    expect(source).toMatch(/onClick=\{onRescan\}[\s\S]{0,60}disabled=\{rescanning \|\| loading\}/)
  })

  test('onRescan is typed as a callback prop, not a boolean flag', () => {
    expect(source).toMatch(/onRescan:\s*\(\)\s*=>\s*void/)
  })
})
