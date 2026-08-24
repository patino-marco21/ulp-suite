/**
 * Confirms the matches dialog/state extracted out of app/monitoring/page.tsx
 * into hooks/useMonitorMatches.ts + components/monitor-matches-dialog.tsx
 * preserved the exact behavior that used to live inline — same endpoint,
 * same request-sequencing guard, same error copy — rather than a subtly
 * different rewrite. Source-text style, matching
 * __tests__/monitor-matches-route.test.ts's convention: this project's
 * Vitest runs in a node environment with no jsdom/React Testing Library,
 * so behavioral component tests aren't available here.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('shared matches hook + dialog', () => {
  const hook = readFileSync(new URL('../hooks/useMonitorMatches.ts', import.meta.url), 'utf8')
  const dialog = readFileSync(new URL('../components/monitor-matches-dialog.tsx', import.meta.url), 'utf8')
  const monitoringPage = readFileSync(new URL('../app/monitoring/page.tsx', import.meta.url), 'utf8')

  test('hook fetches the same per-monitor matches endpoint', () => {
    expect(hook).toContain('/api/monitoring/monitors/${monitor.id}/matches')
  })

  test('hook keeps the stale-response guard', () => {
    // A cold phase-1 cache makes this request seconds long; switching
    // monitors mid-flight must not let an older response overwrite state.
    expect(hook).toContain('matchesRequestId')
    expect(hook).toMatch(/requestId !== matchesRequestId\.current/)
  })

  test('hook keeps the exact error copy for both failure branches', () => {
    expect(hook).toContain('The match query failed. Results below are unavailable — this is not a confirmation that nothing matches.')
    expect(hook).toContain('Could not reach the server. Results are unavailable — this is not a confirmation that nothing matches.')
  })

  test('dialog keeps the failed-query-before-empty-state branch order', () => {
    // A failed query is not evidence of zero matches — rendering "No
    // current matches" for one would be an authoritative false negative.
    const errorIdx = dialog.indexOf('error ?')
    const emptyIdx = dialog.indexOf('No current matches')
    expect(errorIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(errorIdx)
  })

  test('dialog keeps the NEW badge and matches table columns', () => {
    expect(dialog).toContain('is_new')
    expect(dialog).toContain('NEW')
    expect(dialog).toMatch(/URL[\s\S]*Email[\s\S]*Password[\s\S]*Domain/)
  })

  test('monitoring page no longer defines its own openMatches — it imports the shared hook', () => {
    expect(monitoringPage).not.toMatch(/const openMatches = async/)
    expect(monitoringPage).toContain('useMonitorMatches')
    expect(monitoringPage).toContain('MonitorMatchesDialog')
  })

  test('monitoring page still offers the View Matches action', () => {
    expect(monitoringPage).toContain('View Matches')
    expect(monitoringPage).toMatch(/onClick=\{\(\) => openMatches\(monitor\)\}/)
  })
})
