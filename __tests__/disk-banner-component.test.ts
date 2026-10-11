import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const banner = readFileSync(new URL('../components/disk-banner.tsx', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../components/client-layout-with-sidebar.tsx', import.meta.url), 'utf8')

describe('DiskBanner component', () => {
  test('is a client component that polls the disk endpoint every minute while the tab is visible', () => {
    expect(banner.startsWith('"use client"')).toBe(true)
    expect(banner).toContain('fetch("/api/monitoring/disk", { cache: "no-store" })')
    expect(banner).toContain('const POLL_MS = 60_000')
    expect(banner).toContain('document.visibilityState')
    expect(banner).toContain('visibilitychange')
  })

  test('shows nothing for a refusal (logged out, not an admin) and keeps the last banner through a network blip', () => {
    expect(banner).toContain('if (!res.ok) {')
    expect(banner).toContain('setBanner(null)')
    expect(banner).toMatch(/catch \{\s*\/\*/)
  })

  test('uses the pure wording module and imports nothing from the server side', () => {
    expect(banner).toContain('describeDiskBanner(data.disk, data.gate)')
    expect(banner).not.toMatch(/from "@\/lib\/(clickhouse|disk-watch|ingest-disk-gate|auth)"/)
  })

  test('is an alert for critical and paused, a status for warn, and links to Ingest Health', () => {
    expect(banner).toContain('role={banner.level === "warn" ? "status" : "alert"}')
    expect(banner).toContain('data-testid="disk-banner"')
    expect(banner).toContain('href="/upload"')
    expect(banner).toContain('Ingest Health')
  })
})

describe('layout', () => {
  test('renders the banner between the header and the page, and not on the standalone pages', () => {
    expect(layout).toContain('import DiskBanner from "@/components/disk-banner"')
    const header = layout.indexOf('<AppHeader title={title} />')
    const banner = layout.indexOf('<DiskBanner />')
    const main = layout.indexOf('<main className="flex-1 bg-background">{children}</main>', header)
    expect(header).toBeGreaterThan(-1)
    expect(banner).toBeGreaterThan(header)
    expect(main).toBeGreaterThan(banner)
    const standalone = layout.slice(layout.indexOf('if (pathname === "/login"'), layout.indexOf('return (\n    <>'))
    expect(standalone).not.toContain('DiskBanner')
  })
})
