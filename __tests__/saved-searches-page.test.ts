/**
 * Source-shape guards for app/saved-searches/page.tsx and its sidebar
 * entry. This project's Vitest runs in a node environment with no
 * jsdom/React Testing Library, so — matching
 * __tests__/monitor-matches-route.test.ts's precedent — this pins the
 * structural decisions a code review can't casually miss (read-only, not
 * admin-gated, correct data source, correct sidebar position) rather than
 * rendering the component.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('saved searches page', () => {
  const page = readFileSync(new URL('../app/saved-searches/page.tsx', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../components/app-sidebar.tsx', import.meta.url), 'utf8')

  test('is read-only — no monitor create/edit/delete/webhook affordances', () => {
    expect(page).not.toMatch(/createMonitor|updateMonitor|deleteMonitor|handleSaveMonitor|handleDeleteMonitor|showMonitorDialog/)
    expect(page).not.toMatch(/webhook/i)
  })

  test('is not admin-gated', () => {
    expect(page).not.toContain('isAdmin')
    expect(page).not.toContain('requireAdminRole')
  })

  test('fetches the active-only monitors list and reuses the shared matches dialog', () => {
    expect(page).toContain('/api/monitoring/monitors?active_only=true')
    expect(page).toContain('useMonitorMatches')
    expect(page).toContain('MonitorMatchesDialog')
  })

  test('renders a last-viewed indicator sourced from last_viewed_at', () => {
    expect(page).toContain('last_viewed_at')
    expect(page).toContain('formatRelativeTime')
    expect(page).toContain('Never viewed')
  })

  test('sidebar has a Saved Searches entry positioned between Batch Lookup and Breaches', () => {
    const searchGroup = sidebar.match(/title: "Search",[\s\S]*?items: \[([\s\S]*?)\]/)
    expect(searchGroup).toBeTruthy()
    const items = searchGroup![1]
    const batchIdx = items.indexOf('"Batch Lookup"')
    const savedIdx = items.indexOf('"Saved Searches"')
    const breachesIdx = items.indexOf('"Breaches"')
    expect(batchIdx).toBeGreaterThan(-1)
    expect(savedIdx).toBeGreaterThan(batchIdx)
    expect(breachesIdx).toBeGreaterThan(savedIdx)
  })

  test('sidebar entry is not admin-gated and points at /saved-searches', () => {
    const entryMatch = sidebar.match(/\{\s*title:\s*"Saved Searches"[^}]*\}/)
    expect(entryMatch).toBeTruthy()
    const entry = entryMatch![0]
    expect(entry).toContain('url: "/saved-searches"')
    expect(entry).not.toContain('adminOnly')
  })
})
