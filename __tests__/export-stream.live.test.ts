import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

/**
 * LIVE check of the streamed export (app/api/export/route.ts, lib/export-stream.ts): a big-site export through the real handler against the real
 * ClickHouse container. Skipped unless ECS_LIVE=1. READ-ONLY. It never keeps the file: it counts bytes and rows as they arrive and samples the
 * process memory, so it also shows that the stream does not hold the export in memory. It prints the time to the first byte, the rows, the bytes
 * and the memory growth.
 *
 *   ECS_LIVE=1 npx vitest run __tests__/export-stream.live.test.ts
 *   ECS_LIVE=1 ECS_TERM=some.site npx vitest run __tests__/export-stream.live.test.ts
 *
 * ECS_TERM is the search term (default a public brand). Real search terms belong in YOUR environment, never in this file: the repository is public.
 */
const LIVE = process.env.ECS_LIVE === '1'
const TERM = process.env.ECS_TERM ?? 'google.com'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

describe.skipIf(!LIVE)('streamed export on the live table', () => {
  test.each(['csv', 'ndjson'])('%s: a big-site export streams, is complete line by line and does not grow the heap by the file size', async format => {
    const { POST } = await import('@/app/api/export/route')
    const { NextRequest } = await import('next/server')
    const rssBefore = process.memoryUsage().rss
    const t0 = Date.now()
    const res = await POST(new NextRequest('http://localhost/api/export', {
      method: 'POST', body: JSON.stringify({ format, query: TERM, sort: 'domain_asc', dedupe: '0' }),
    }))
    const answeredMs = Date.now() - t0
    expect(res.status).toBe(200)
    const cap = Number(res.headers.get('X-Export-Cap'))
    expect(cap).toBe(1_000_000)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let newlines = 0
    let firstByteMs = -1
    let peakRss = rssBefore
    let head = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (firstByteMs < 0) firstByteMs = Date.now() - t0
      bytes += value.length
      for (let i = 0; i < value.length; i++) if (value[i] === 10) newlines++
      if (head.length < 200_000) head += decoder.decode(value, { stream: true })
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }
    const rows = newlines - (format === 'csv' ? 1 : 0)
    const growthMiB = Math.round((peakRss - rssBefore) / 1048576)
    console.log(`${format} | term ${TERM.length} chars | answered after ${answeredMs} ms, first byte ${firstByteMs} ms, total ${Date.now() - t0} ms | ${rows} rows | ${Math.round(bytes / 1048576)} MiB | memory grew ${growthMiB} MiB`)

    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThanOrEqual(cap)
    const lines = head.split('\n').slice(format === 'csv' ? 1 : 0, 200).filter(Boolean)
    if (format === 'ndjson') for (const l of lines.slice(0, 100)) expect(() => JSON.parse(l)).not.toThrow()
    else for (const l of lines.slice(0, 100)) expect((l.match(/","/g) ?? []).length).toBeGreaterThanOrEqual(15) // 16 quoted cells (a quote pattern inside a value can only add)
    // the file is hundreds of MiB for a million rows; holding it would show here
    expect(growthMiB).toBeLessThan(Math.max(300, Math.round(bytes / 1048576 / 2)))
  }, 30 * 60_000)
})
