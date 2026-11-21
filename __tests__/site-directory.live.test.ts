import { execSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

/**
 * LIVE check of the Site Directory's breakdown (lib/site-directory-breakdown.ts) against the real ulp.credentials (the running ulpsuite_clickhouse
 * container); design: docs/superpowers/specs/2026-11-21-site-directory-design.md. READ-ONLY. Skipped unless BLK_LIVE=1:
 *
 *   BLK_LIVE=1 npx vitest run __tests__/site-directory.live.test.ts
 *
 * It needs no values of yours and prints none, only labels, counts and timings. It samples real hosts from the table and checks, for each:
 *   1. PARITY: the split equals what ONE full scan (no projection, no index, `domain = host OR endsWith(domain, '.host')`) gives, worked out in plain code;
 *   2. the four parts add up to the site's count from the counting query (so the split and the count mean the same rows);
 *   3. the query finishes inside its time limit.
 * and that a site with no rows splits into four zeros.
 */
const LIVE = process.env.BLK_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

const SAMPLE = 'SETTINGS max_execution_time = 120'
// No backslashes in the pattern: it goes through a template literal and a ClickHouse string literal.
const HOST = `^[a-z0-9-]+([.][a-z0-9-]+)+$`

/** Hosts by how they are stored: some sampled from recent rows, and the site that contains one of them (it has at least that subdomain). */
async function sampleHosts(): Promise<string[]> {
  const { executeQuery } = await import('@/lib/clickhouse')
  const stored = (await executeQuery(
    `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
     GROUP BY domain ORDER BY rand() LIMIT 120 ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain)
  const parents = Array.from(new Set(stored.slice(3, 40).map(d => d.split('.').slice(1).join('.')).filter(p => p.includes('.')))).slice(0, 2)
  return [...stored.slice(0, 3), ...parents]
}

/** One full scan with nothing to help it: the split of every listed host, from the rows of every stored domain that is the host or ends with `.host`. */
async function scanSplits(hosts: string[]): Promise<Map<string, { email: number; phone: number; username: number; other: number }>> {
  const { executeQuery } = await import('@/lib/clickhouse')
  const params: Record<string, string> = {}
  const terms: string[] = []
  hosts.forEach((h, i) => {
    params[`h${i}`] = h
    params[`s${i}`] = `.${h}`
    terms.push(`domain = {h${i}:String} OR endsWith(domain, {s${i}:String})`)
  })
  const rows = await executeQuery(
    `SELECT domain, login_type, count() AS n FROM ulp.credentials WHERE (${terms.join(' OR ')}) GROUP BY domain, login_type
     SETTINGS max_execution_time = 280, optimize_use_projections = 0, optimize_use_projection_filtering = 0, use_skip_indexes = 0`, params) as Array<{ domain: string; login_type: string; n: string }>
  const out = new Map<string, { email: number; phone: number; username: number; other: number }>()
  for (const host of hosts) {
    const split = { email: 0, phone: 0, username: 0, other: 0 }
    for (const r of rows) {
      if (r.domain !== host && !r.domain.endsWith(`.${host}`)) continue
      const key = r.login_type === 'email' || r.login_type === 'phone' || r.login_type === 'username' ? r.login_type : 'other'
      split[key] += Number(r.n)
    }
    out.set(host, split)
  }
  return out
}

describe.skipIf(!LIVE)('the Site Directory breakdown on the live table', () => {
  test('PARITY: the split equals a plain full scan, adds up to the site\'s count, and finishes inside the time limit', async () => {
    const { breakdownFor, BREAKDOWN_QUERY_SECONDS } = await import('@/lib/site-directory-breakdown')
    const { countSites } = await import('@/lib/site-counts')
    const hosts = await sampleHosts()
    expect(hosts.length).toBeGreaterThanOrEqual(3)
    const expected = await scanSplits(hosts)
    for (const [i, host] of hosts.entries()) {
      const t = Date.now()
      const split = await breakdownFor(host)
      const ms = Date.now() - t
      const counted = (await countSites([host], { lower: null, upper: null })).results[host]
      const total = split.email + split.phone + split.username + split.other
      console.warn(`  site ${i + 1}/${hosts.length}: ${total.toLocaleString()} rows, ${ms} ms, e-mail ${split.email} phone ${split.phone} user name ${split.username} other ${split.other}`)
      expect(split, `site ${i + 1}: the split equals the full scan`).toEqual(expected.get(host))
      expect(total, `site ${i + 1}: the parts add up to the count`).toBe(counted.count)
      expect(ms, `site ${i + 1}: inside the time limit`).toBeLessThan(BREAKDOWN_QUERY_SECONDS * 1000)
    }
  }, 600_000)

  test('a site with no rows splits into four zeros', async () => {
    const { breakdownFor } = await import('@/lib/site-directory-breakdown')
    expect(await breakdownFor(`zz-absent-${Date.now()}.no-such-host.invalid`)).toEqual({ email: 0, phone: 0, username: 0, other: 0 })
  })
})
