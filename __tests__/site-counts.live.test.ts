import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

/**
 * LIVE check of the site counts (POST /api/lookup/counts and POST /api/v1/lookup/counts, lib/site-counts.ts) against the real ulp.credentials (the
 * running ulpsuite_clickhouse container); design: docs/superpowers/specs/2026-10-26-site-counts-design.md. READ-ONLY. Skipped unless BLK_LIVE=1:
 *
 *   BLK_LIVE=1 npx vitest run __tests__/site-counts.live.test.ts
 *
 * It needs no values of yours and prints none, only labels, counts and timings. It samples real hosts from the table, then checks:
 *   1. PARITY: for sites as they are stored (a host, the site that contains it, a `www.` spelling, a site with no row) the answer equals what ONE full scan
 *      with `endsWith(domain, '.host')` and no projection gives, worked out in plain code: rows on the host, rows on subdomains, how many subdomains, and
 *      the ten biggest in order. The scan shares nothing with the query under test (no reversed key, no suffix expansion);
 *   2. the same under an imported window;
 *   3. every shape people paste (a URL, a www. host, host:port, a wildcard, padded text) is counted as the bare host;
 *   4. a list of 100 sites is counted well inside the time of one request, and the query reads a small part of the table (EXPLAIN);
 *   5. the fallback that counts only hosts agrees with the answer's host counts.
 */
vi.mock('@/lib/auth', () => ({
  validateRequest: async () => ({ id: 1, username: 'live-test', role: 'admin' }),
}))
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: async () => ({ success: true, apiKey: { keyId: 'live-test', role: 'admin' }, rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 } }),
  addRateLimitHeaders: (response: unknown) => response,
  logApiRequest: async () => undefined,
}))

const LIVE = process.env.BLK_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

type Route = 'internal' | 'v1'
interface Count {
  host: string; found: boolean; count: number | null; host_count: number | null; subdomain_count: number | null; subdomains: number | null
  top_subdomains: Array<{ domain: string; count: number }>; searched_as?: string; error?: string
}
interface Answer { status: number; found: number | null; queried: number | null; results: Record<string, Count>; subdomains_counted: boolean | null; ms: number; error?: string }

async function ask(route: Route, body: { domains: string[]; imported_after?: string; imported_before?: string }): Promise<Answer> {
  const { NextRequest } = await import('next/server')
  const handler = route === 'internal'
    ? (await import('@/app/api/lookup/counts/route')).POST
    : (await import('@/app/api/v1/lookup/counts/route')).POST
  const path = route === 'internal' ? '/api/lookup/counts' : '/api/v1/lookup/counts'
  const t = Date.now()
  const res = await handler(new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const ms = Date.now() - t
  const json = await res.json() as { found?: number; queried?: number; error?: string; results?: Record<string, Count>; subdomains_counted?: boolean }
  return { status: res.status, found: json.found ?? null, queried: json.queried ?? null, results: json.results ?? {}, subdomains_counted: json.subdomains_counted ?? null, ms, error: json.error }
}

const ROUTES: Route[] = ['internal', 'v1']
const SAMPLE = 'SETTINGS max_execution_time = 120'
// No backslashes in the pattern: it goes through a template literal and a ClickHouse string literal.
const HOST = `^[a-z0-9-]+([.][a-z0-9-]+)+$`
const WWW_HOST = `^www[.][a-z0-9-]+([.][a-z0-9-]+)+$`

/** What the plain full scan says a site's numbers are, from the rows of every stored domain. */
function expected(host: string, byDomain: Map<string, number>) {
  let host_count = 0
  let subdomain_count = 0
  const subs: Array<{ domain: string; count: number }> = []
  for (const [d, n] of byDomain) {
    if (d === host || d === `www.${host}`) host_count += n
    else if (d.endsWith(`.${host}`)) {
      subdomain_count += n
      subs.push({ domain: d, count: n })
    }
  }
  subs.sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : 1))
  return { count: host_count + subdomain_count, host_count, subdomain_count, subdomains: subs.length, top: subs.slice(0, 10) }
}

/** One full scan, no projection and no index: the rows of every stored domain that is one of `hosts`, its www. spelling or a subdomain of it. */
async function scan(hosts: string[], window = ''): Promise<Map<string, number>> {
  const { executeQuery } = await import('@/lib/clickhouse')
  const params: Record<string, string> = {}
  const terms: string[] = []
  hosts.forEach((h, i) => {
    params[`h${i}`] = h
    params[`w${i}`] = `www.${h}`
    params[`s${i}`] = `.${h}`
    terms.push(`domain = {h${i}:String} OR domain = {w${i}:String} OR endsWith(domain, {s${i}:String})`)
  })
  const rows = await executeQuery(
    `SELECT domain, count() AS n FROM ulp.credentials WHERE (${terms.join(' OR ')})${window}
     GROUP BY domain SETTINGS max_execution_time = 280, optimize_use_projections = 0, optimize_use_projection_filtering = 0, use_skip_indexes = 0`, params) as Array<{ domain: string; n: string }>
  return new Map(rows.map(r => [r.domain, Number(r.n)]))
}

/** Hosts to count, by how they are stored: sampled from recent rows, the site that contains each, a www. spelling, and sites with no row. */
async function sampleHosts(): Promise<{ exact: string[]; parents: string[]; www: string[]; absent: string[]; recent: string[] }> {
  const { executeQuery } = await import('@/lib/clickhouse')
  const stored = (await executeQuery(
    `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
     GROUP BY domain ORDER BY rand() LIMIT 120 ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain)
  const exact = stored.slice(0, 8)
  // The site that contains a sampled domain: it has at least that subdomain. Only when it still has a dot of its own (no bare top-level name).
  const parents = Array.from(new Set(stored.slice(8, 60).map(d => d.split('.').slice(1).join('.')).filter(p => p.includes('.')))).slice(0, 8)
  // PK range on the first column: cheap. What follows the `www.` must itself be a site (`www.ch` is a stored domain, and `ch` is not a site address).
  const www = (await executeQuery(
    `SELECT domain FROM ulp.credentials WHERE startsWith(domain, 'www.') AND match(domain, '${WWW_HOST}') GROUP BY domain LIMIT 3 ${SAMPLE}`, {}) as Array<{ domain: string }>)
    .map(r => r.domain.slice(4))
  const absent = [0, 1].map(i => `zz-absent-${Date.now()}-${i}.no-such-host.invalid`)
  return { exact, parents, www, absent, recent: stored }
}

describe.skipIf(!LIVE)('the site counts on the live table', () => {
  test('PARITY: the counts equal a plain full scan, worked out in code, for every kind of site', async () => {
    const s = await sampleHosts()
    const hosts = Array.from(new Set([...s.exact, ...s.parents, ...s.www, ...s.absent]))
    expect(s.exact.length, 'hosts were sampled').toBeGreaterThan(4)
    expect(s.parents.length, 'sites that contain a sampled host were derived').toBeGreaterThan(2)
    expect(s.www.length, 'sites stored with a www. spelling were found').toBeGreaterThan(0)

    const t0 = Date.now()
    const byDomain = await scan(hosts)
    const scanMs = Date.now() - t0

    const lines: string[] = []
    let withSubdomains = 0
    let withWww = 0
    for (const route of ROUTES) {
      const a = await ask(route, { domains: hosts })
      expect(a.status, `${route}: status`).toBe(200)
      expect(a.subdomains_counted, `${route}: subdomains are counted`).toBe(true)
      let mismatches = 0
      for (const host of hosts) {
        const got = a.results[host]
        const want = expected(host, byDomain)
        const same = got.count === want.count && got.host_count === want.host_count && got.subdomain_count === want.subdomain_count
          && got.subdomains === want.subdomains && JSON.stringify(got.top_subdomains) === JSON.stringify(want.top)
        if (!same) mismatches++
        expect(got.count, `${route}: rows`).toBe(want.count)
        expect(got.host_count, `${route}: rows on the host`).toBe(want.host_count)
        expect(got.subdomain_count, `${route}: rows on subdomains`).toBe(want.subdomain_count)
        expect(got.subdomains, `${route}: subdomains`).toBe(want.subdomains)
        expect(got.top_subdomains, `${route}: the biggest subdomains, in order`).toEqual(want.top)
        expect(got.found).toBe(want.count > 0)
        if (route === 'internal') {
          if (want.subdomains > 0) withSubdomains++
          if ((byDomain.get(`www.${host}`) ?? 0) > 0) withWww++
        }
      }
      lines.push(`${route.padEnd(8)} ${hosts.length} sites  mismatches=${mismatches}  ${a.ms} ms`)
    }
    for (const host of s.absent) expect((await ask('internal', { domains: [host] })).results[host]).toMatchObject({ found: false, count: 0 })
    lines.push(`scan (no projection): ${scanMs} ms; sites with subdomains=${withSubdomains}, with a www. spelling stored=${withWww}`)
    expect(withSubdomains, 'the sample includes sites with subdomains').toBeGreaterThan(2)
    expect(withWww, 'the sample includes a site stored with its www. spelling').toBeGreaterThan(0)
    console.log(`\n=== site counts parity (values withheld) ===\n${lines.join('\n')}\n`)
  }, 900_000)

  test('PARITY under an imported window: the same counts as the scan with the same bound, and never more than without it', async () => {
    const s = await sampleHosts()
    const hosts = Array.from(new Set([...s.exact, ...s.parents])).slice(0, 12)
    const after = new Date(Date.now() - 10 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
    const afterEpoch = Math.floor(Date.parse(after) / 1000)
    const byDomain = await scan(hosts, ` AND imported_at > toDateTime(${afterEpoch})`)
    const all = await ask('internal', { domains: hosts })
    const lines: string[] = []
    for (const route of ROUTES) {
      const a = await ask(route, { domains: hosts, imported_after: after })
      expect(a.status, `${route}: status`).toBe(200)
      for (const host of hosts) {
        const want = expected(host, byDomain)
        expect(a.results[host].count, `${route}: rows in the window`).toBe(want.count)
        expect(a.results[host].host_count).toBe(want.host_count)
        expect(a.results[host].subdomain_count).toBe(want.subdomain_count)
        expect(a.results[host].subdomains).toBe(want.subdomains)
        expect(a.results[host].count!, 'a window never adds rows').toBeLessThanOrEqual(all.results[host].count!)
      }
      lines.push(`${route.padEnd(8)} ${hosts.length} sites in a 10-day window  ${a.ms} ms`)
    }
    console.log(`\n=== site counts, window ===\n${lines.join('\n')}\n`)
  }, 900_000)

  test('every shape people paste is counted as the bare host', async () => {
    const s = await sampleHosts()
    const D = s.parents[0]
    const shapes: Array<[string, string]> = [
      ['s0 bare host', D],
      ['s1 https://host', `https://${D}`],
      ['s2 https://host/path?query', `https://${D}/login?next=/a/b`],
      ['s3 http://www.host/', `http://www.${D}/`],
      ['s4 WWW.HOST upper-case', `WWW.${D.toUpperCase()}`],
      ['s5 host:port', `${D}:8443`],
      ['s6 https://user@host/path', `https://user@${D}/path`],
      ['s7 *.host wildcard', `*.${D}`],
      ['s8 .host', `.${D}`],
      ['s9 padded with spaces', `  ${D}  `],
      ['s10 "quoted",', `"${D}",`],
    ]
    const lines: string[] = []
    for (const route of ROUTES) {
      const base = (await ask(route, { domains: [D] })).results[D]
      expect(base.count, `${route}: the control site has rows`).toBeGreaterThan(0)
      const a = await ask(route, { domains: shapes.map(([, v]) => v) })
      expect(a.status).toBe(200)
      for (const [label, value] of shapes) {
        const got = a.results[value]
        lines.push(`${route.padEnd(8)} ${label.padEnd(28)} count=${got.count} host=${got.host_count} sub=${got.subdomain_count}`)
        expect(got.count, `${route} ${label}: the same rows as the bare host`).toBe(base.count)
        expect(got.subdomain_count, `${route} ${label}`).toBe(base.subdomain_count)
        expect(got.error).toBeUndefined()
      }
    }
    console.log(`\n=== pasted shapes (values withheld) ===\n${lines.join('\n')}\n`)
  }, 600_000)

  test('a list of 100 sites is counted well inside one request, and the query leaves a small part of the table', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { subdomainCountsSql } = await import('@/lib/site-counts')
    const s = await sampleHosts()
    const sites = Array.from(new Set([...s.recent, ...s.parents])).slice(0, 100)
    expect(sites.length, 'a hundred sites were sampled').toBe(100)
    const lines: string[] = []
    for (const route of ROUTES) {
      const a = await ask(route, { domains: sites })
      lines.push(`${route.padEnd(8)} ${sites.length} sites  status=${a.status} found=${a.found}/${a.queried} ${a.ms} ms`)
      expect(a.status).toBe(200)
      expect(a.found, `${route}: every sampled site has rows`).toBe(sites.length)
      expect(Object.values(a.results).filter(r => r.error), `${route}: every site was counted`).toHaveLength(0)
      // Measured cold: about 22 ms a site; the cap of one request is 45 s.
      expect(a.ms, `${route}: 100 sites`).toBeLessThan(20_000)
    }
    const { sql, params } = subdomainCountsSql(sites.slice(0, 20), { lower: null, upper: null })
    const plan = (await executeQuery(`EXPLAIN indexes = 1 ${sql}`, params) as Array<{ explain: string }>).map(r => r.explain).join('\n')
    const granules = [...plan.matchAll(/Granules: (\d+)\/(\d+)/g)].map(m => [Number(m[1]), Number(m[2])])
    expect(granules.length, 'the plan names the granules it reads').toBeGreaterThan(0)
    const [read, total] = granules[granules.length - 1]
    lines.push(`EXPLAIN, 20 sites: ${read} of ${total} granules (${((read / total) * 100).toFixed(2)}%), projection used: ${plan.includes('proj_domain_rev')}`)
    expect(plan, 'the reversed-domain key serves the scan').toContain('proj_domain_rev')
    expect(read / total, 'a small part of the table is read').toBeLessThan(0.1)
    console.log(`\n=== 100 sites ===\n${lines.join('\n')}\n`)
  }, 900_000)

  test('the fallback that counts only hosts agrees with the answer on the rows of the hosts', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { hostCountsSql, hostRowsToCounts } = await import('@/lib/site-counts')
    const s = await sampleHosts()
    const hosts = Array.from(new Set([...s.exact, ...s.parents, ...s.www, ...s.absent]))
    const { sql, params } = hostCountsSql(hosts, { lower: null, upper: null })
    const rows = await executeQuery(sql, params)
    const hostOnly = hostRowsToCounts(hosts, rows)
    const a = await ask('internal', { domains: hosts })
    for (const host of hosts) expect(hostOnly.get(host)!.host_count, 'rows on the host').toBe(a.results[host].host_count)
    console.log(`\n=== host-only fallback ===\n${hosts.length} sites agree\n`)
  }, 600_000)
})
