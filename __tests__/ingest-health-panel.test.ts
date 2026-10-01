import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const panel = readFileSync(new URL('../components/ingest-health-panel.tsx', import.meta.url), 'utf8')

describe('Ingest Health panel — free disk space and backups', () => {
  test('shows free space on the data disk, coloured by status, and says so when it cannot be read', () => {
    expect(panel).toContain('data-testid="disk-free"')
    expect(panel).toMatch(/disk\.status === "critical" \? "text-red-600/)
    expect(panel).toMatch(/disk\.status === "warn" \? "text-amber-600/)
    expect(panel).toContain('disk free: unknown')
  })

  test('says "No ClickHouse backup recorded" until one is, and flags stale or this-disk-only backups', () => {
    expect(panel).toContain('data-testid="backup-status"')
    expect(panel).toContain('No ClickHouse backup recorded')
    expect(panel).toContain('(this disk only)')
    expect(panel).toContain('(off-host)')
    expect(panel).toContain('— stale')
    expect(panel).toContain('No SQLite snapshot yet')
  })

  test('both new blocks are optional in the payload, so an older server response still renders', () => {
    expect(panel).toMatch(/disk\?: \{/)
    expect(panel).toMatch(/backup\?: \{/)
    expect(panel).toContain('{disk && (')
    expect(panel).toContain('{backup && (')
  })
})
