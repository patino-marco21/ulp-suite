/**
 * Tests hooks/useMonitorMatches.ts's rescanNow action and the
 * checkedAt/neverScanned/lastError cache-freshness state added alongside
 * it (Task 10). Source-text style, matching
 * __tests__/monitor-matches-shared.test.ts's convention: this project's
 * Vitest runs in a node environment (see vitest.config.ts), and none of
 * @testing-library/react, jsdom, happy-dom, or react-test-renderer are
 * installed — so there is no way to actually render this hook (its
 * useState/useRef calls need a React dispatcher, which only exists inside
 * a render pass driven by a renderer). These assertions pin the
 * source-level facts a behavioral test would otherwise check: the
 * endpoint/method rescanNow calls, that it shares openMatches's
 * applyResult + request-sequencing guard rather than a parallel
 * implementation, and the full return-value shape.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('useMonitorMatches — rescanNow', () => {
  const hook = readFileSync(new URL('../hooks/useMonitorMatches.ts', import.meta.url), 'utf8')

  test('rescanNow POSTs to the per-monitor rescan endpoint', () => {
    expect(hook).toMatch(
      /const rescanNow = async[\s\S]*?fetch\(`\/api\/monitoring\/monitors\/\$\{matchesMonitor\.id\}\/matches\/rescan`,\s*\{\s*method:\s*['"]POST['"]\s*\}\)/
    )
  })

  test('rescanNow no-ops when no monitor panel is open, before touching the request-sequencing counter', () => {
    // The null-check must be the FIRST statement — if it ran after
    // `++matchesRequestId.current`, a no-op call would still burn a request
    // id and could spuriously invalidate an in-flight openMatches call.
    expect(hook).toMatch(/const rescanNow = async \(\) => \{\s*if \(!matchesMonitor\) return/)
  })

  test('rescanNow reuses the single matchesRequestId guard — no second, independently-racing ref', () => {
    expect(hook.match(/useRef\(0\)/g) || []).toHaveLength(1)
    expect(hook).toMatch(/const matchesRequestId = useRef\(0\)/)
    expect(hook).toMatch(/const rescanNow = async[\s\S]*?const requestId = \+\+matchesRequestId\.current/)
    expect(hook).toMatch(/const rescanNow = async[\s\S]*?requestId !== matchesRequestId\.current/)
  })

  test('rescanNow applies a successful response through the same applyResult openMatches uses, not a duplicate', () => {
    expect(hook).toMatch(/const applyResult = \(data: MatchesApiResponse\) => \{/)
    // Exactly two call sites: openMatches's success branch and rescanNow's.
    // A hand-rolled second copy of the field assignments in rescanNow would
    // be exactly the kind of subtly-different-rewrite the shared-hook test
    // guards against for openMatches.
    const applyResultCalls = hook.match(/\bapplyResult\(data\)/g) || []
    expect(applyResultCalls).toHaveLength(2)

    expect(hook).toMatch(/const applyResult[\s\S]*?setCheckedAt\(data\.checked_at \?\? null\)/)
    expect(hook).toMatch(/const applyResult[\s\S]*?setNeverScanned\(Boolean\(data\.never_scanned\)\)/)
    expect(hook).toMatch(/const applyResult[\s\S]*?setLastError\(data\.last_error \?\? null\)/)
  })

  test('rescanNow clears a stale matchesError banner on success', () => {
    expect(hook).toMatch(
      /const rescanNow = async[\s\S]*?if \(data\.success\) \{\s*setMatchesError\(null\)\s*applyResult\(data\)/
    )
  })

  test('rescanning tracks only the in-flight POST, guarded by the request id (mirrors matchesLoading)', () => {
    expect(hook).toMatch(/const rescanNow = async[\s\S]*?setRescanning\(true\)/)
    expect(hook).toMatch(
      /const rescanNow = async[\s\S]*?finally \{\s*if \(requestId === matchesRequestId\.current\) setRescanning\(false\)/
    )
  })

  test('rescanNow reports failures via a distinct "Rescan failed" toast', () => {
    expect(hook).toMatch(/const rescanNow = async[\s\S]*?toast\(\{ title: "Rescan failed"/)
  })

  test('openMatches resets the cache-metadata fields so a newly opened monitor never shows a stale one\'s freshness', () => {
    expect(hook).toMatch(/const openMatches = async[\s\S]*?setCheckedAt\(null\)/)
    expect(hook).toMatch(/const openMatches = async[\s\S]*?setNeverScanned\(false\)/)
    expect(hook).toMatch(/const openMatches = async[\s\S]*?setLastError\(null\)/)
  })

  test('hook return value exposes checkedAt, neverScanned, lastError, rescanning and rescanNow', () => {
    const returnBlock = hook.slice(hook.lastIndexOf('return {'))
    for (const key of ['checkedAt', 'neverScanned', 'lastError', 'rescanning', 'rescanNow']) {
      expect(returnBlock).toContain(key)
    }
  })
})
