import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

/**
 * LIVE check of the two batch lookups (POST /api/lookup/batch and POST /api/v1/lookup/batch) against the real ulp.credentials (the running
 * ulpsuite_clickhouse container); design: docs/superpowers/specs/2026-10-26-batch-lookup-design.md. READ-ONLY. Skipped unless BLK_LIVE=1:
 *
 *   BLK_LIVE=1 npx vitest run __tests__/batch-lookup.live.test.ts
 *
 * It needs no values of yours and prints none, only labels, booleans, counts and timings. It samples real entries from the table, then checks:
 *   1. every shape people paste (a URL, a www. host, host:port, padded text, <addr>, mailto:addr, addr:password, any casing) finds the entry, on both routes;
 *   2. a full batch of 100 domains and of 100 addresses is found in full and well inside the 30 s cap (the address batch took 26-38 s before the index hint);
 *   3. PARITY: for addresses stored in mixed case, written with punctuation, non-ASCII or absent, one batch returns exactly the rows that a separate
 *      `lower(email) = lower(value)` query per address returns (that oracle uses the bloom filter only: no text index, no hint, no prefilter);
 *   4. the words the hint is built from are what ClickHouse's own index tokenizer cuts, on 200,000 real ASCII logins;
 *   5. the single lookup GET /api/v1/lookup?domain= (cleaned the same way): one real domain in the same ten shapes returns exactly the rows of the bare host;
 *   6. PARITY of the single lookup: for domains as they are stored (clean, with a `www.`, with a `:port`, with a `/path`) the route returns exactly the rows
 *      of one `domain = value` query per value it stands for, so no row the old exact comparison found is lost.
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
interface Hit { found: boolean; count: number; results: Array<Record<string, string>>; searched_as?: string }
interface Answer { status: number; found: number | null; queried: number | null; results: Record<string, Hit>; ms: number; error?: string }

async function ask(route: Route, body: { emails?: string[]; domains?: string[] }): Promise<Answer> {
  const { NextRequest } = await import('next/server')
  const handler = route === 'internal'
    ? (await import('@/app/api/lookup/batch/route')).POST
    : (await import('@/app/api/v1/lookup/batch/route')).POST
  const path = route === 'internal' ? '/api/lookup/batch' : '/api/v1/lookup/batch'
  const t = Date.now()
  const res = await handler(new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const ms = Date.now() - t
  const json = await res.json() as { found?: number; queried?: number; error?: string; results?: Record<string, Hit> }
  return { status: res.status, found: json.found ?? null, queried: json.queried ?? null, results: json.results ?? {}, ms, error: json.error }
}

interface SingleAnswer {
  status: number
  json: { success?: boolean; found?: boolean; domain?: string; searched_as?: string; count?: number; results?: Array<Record<string, string>>; error?: string }
  ms: number
}

/** GET /api/v1/lookup?domain=<value>, in process like the batch routes above. */
async function askSingle(domain: string): Promise<SingleAnswer> {
  const { NextRequest } = await import('next/server')
  const { GET } = await import('@/app/api/v1/lookup/route')
  const t = Date.now()
  const res = await GET(new NextRequest(`http://localhost/api/v1/lookup?${new URLSearchParams({ domain })}`))
  const ms = Date.now() - t
  return { status: res.status, json: await res.json(), ms }
}

/** The ten ways one domain gets pasted: the same for the batch routes and for the single lookup. */
function domainShapesOf(D: string): Array<[string, string]> {
  return [
    ['d0 bare host', D],
    ['d1 https://host', `https://${D}`],
    ['d2 https://host/path?query', `https://${D}/login?next=/a/b`],
    ['d3 http://www.host/', `http://www.${D}/`],
    ['d4 WWW.HOST upper-case', `WWW.${D.toUpperCase()}`],
    ['d5 host:port', `${D}:8443`],
    ['d6 https://user@host/path', `https://user@${D}/path`],
    ['d7 host/ trailing slash', `${D}/`],
    ['d8 padded with spaces', `  ${D}  `],
    ['d9 "quoted",', `"${D}",`],
  ]
}

const ROUTES: Route[] = ['internal', 'v1']
const SAMPLE = 'SETTINGS max_execution_time = 120'
// No backslashes in the patterns: they go through a template literal and a ClickHouse string literal.
const ASCII_EMAIL = `^[a-z0-9._+-]{3,40}@[a-z0-9-]+([.][a-z0-9-]+)+$`
const HOST = `^[a-z0-9-]+([.][a-z0-9-]+)+$`

/** One line per stored row, hashed so that no value is ever printed: the multiset of rows of an answer. */
function digest(rows: Array<Record<string, string>>): string[] {
  return rows.map(r => `${r.email}\u0001${r.password}\u0001${r.url}\u0001${r.domain}\u0001${r.source_file}\u0001${r.imported_at}`).sort()
}

describe.skipIf(!LIVE)('the batch lookups on the live table', () => {
  test('every shape people paste finds the entry, on both routes', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const domainRows = await executeQuery(
      `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
       GROUP BY domain HAVING count() BETWEEN 3 AND 40 ORDER BY rand() LIMIT 1 ${SAMPLE}`, {}) as Array<{ domain: string }>
    expect(domainRows.length, 'a sample domain exists').toBe(1)
    const D = domainRows[0].domain
    const emailRows = await executeQuery(
      `SELECT email FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND login_type = 'email' AND match(email, '${ASCII_EMAIL}')
       GROUP BY email HAVING count() BETWEEN 1 AND 40 ORDER BY rand() LIMIT 1 ${SAMPLE}`, {}) as Array<{ email: string }>
    expect(emailRows.length, 'a sample address exists').toBe(1)
    const E = emailRows[0].email

    const domainShapes = domainShapesOf(D)
    const emailShapes: Array<[string, string]> = [
      ['e0 exact address', E],
      ['e1 UPPER-CASE', E.toUpperCase()],
      ['e2 padded with spaces', `  ${E}  `],
      ['e3 mailto:address', `mailto:${E}`],
      ['e4 <address>', `<${E}>`],
      ['e5 "address"', `"${E}"`],
      ['e6 Name <address>', `Some Name <${E}>`],
      ['e7 address:password', `${E}:Secret1!`],
      ['e8 address.', `${E}.`],
    ]

    const lines: string[] = []
    for (const route of ROUTES) {
      const base = (await ask(route, { domains: [D] })).results[D]
      const baseE = (await ask(route, { emails: [E] })).results[E]
      expect(base.found, `${route}: the bare host is found (the control)`).toBe(true)
      expect(baseE.found, `${route}: the exact address is found (the control)`).toBe(true)
      for (const [label, value] of domainShapes) {
        const a = await ask(route, { domains: [value] })
        const hit = a.results[value]
        lines.push(`${route.padEnd(8)} ${label.padEnd(28)} status=${a.status} found=${hit?.found} count=${hit?.count} ${a.ms} ms`)
        expect(a.status, `${route} ${label}`).toBe(200)
        expect(hit?.found, `${route} ${label}`).toBe(true)
        expect(hit.count, `${route} ${label}: the same rows as the bare host`).toBe(base.count)
      }
      for (const [label, value] of emailShapes) {
        const a = await ask(route, { emails: [value] })
        const hit = a.results[value]
        lines.push(`${route.padEnd(8)} ${label.padEnd(28)} status=${a.status} found=${hit?.found} count=${hit?.count} ${a.ms} ms`)
        expect(a.status, `${route} ${label}`).toBe(200)
        expect(hit?.found, `${route} ${label}`).toBe(true)
        expect(hit.count, `${route} ${label}: the same rows as the exact address`).toBe(baseE.count)
      }
      // One request with both kinds: a URL in the domain list and a decorated address in the e-mail list.
      const mixed = await ask(route, { domains: [`https://www.${D}/x`], emails: [`<${E}>`] })
      expect(mixed.found, `${route}: both kinds in one request`).toBe(2)
      expect(mixed.results[`https://www.${D}/x`].searched_as).toBe(D)
    }
    console.log(`\n=== pasted shapes (values withheld) ===\n${lines.join('\n')}\n`)
  }, 600_000)

  test('a full batch of 100 domains and of 100 addresses is found in full, well inside the 30 s cap', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const domains = (await executeQuery(
      `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
       GROUP BY domain ORDER BY rand() LIMIT 100 ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain)
    const emails = (await executeQuery(
      `SELECT email FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND login_type = 'email' AND match(email, '${ASCII_EMAIL}')
       GROUP BY email ORDER BY rand() LIMIT 100 ${SAMPLE}`, {}) as Array<{ email: string }>).map(r => r.email)

    const lines: string[] = []
    for (const route of ROUTES) {
      const d = await ask(route, { domains })
      const e = await ask(route, { emails })
      lines.push(`${route.padEnd(8)} ${domains.length} domains  status=${d.status} found=${d.found}/${d.queried} ${d.ms} ms`)
      lines.push(`${route.padEnd(8)} ${emails.length} addresses status=${e.status} found=${e.found}/${e.queried} ${e.ms} ms`)
      expect(d.status).toBe(200)
      expect(e.status).toBe(200)
      expect(d.found, `${route}: every sampled domain is found`).toBe(domains.length)
      expect(e.found, `${route}: every sampled address is found`).toBe(emails.length)
      // Measured warm: ~1 s for the domains and ~3 s for the addresses; 26-38 s for the addresses before the index hint.
      expect(d.ms, `${route}: 100 domains`).toBeLessThan(15_000)
      expect(e.ms, `${route}: 100 addresses`).toBeLessThan(20_000)
    }
    console.log(`\n=== batch of 100 ===\n${lines.join('\n')}\n`)
  }, 900_000)

  test('PARITY: one batch returns exactly the rows a separate lower(email) = lower(value) query per address returns', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const pick = async (where: string, n: number): Promise<string[]> => (await executeQuery(
      `SELECT lower(email) AS v FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND ${where}
       GROUP BY v HAVING count() <= 40 ORDER BY rand() LIMIT ${n} ${SAMPLE}`, {}) as Array<{ v: string }>).map(r => r.v)

    // Non-ASCII logins that the cleaner would leave alone: no separators, brackets or quotes, no trailing punctuation (those are changed ON PURPOSE).
    const plainNonAscii = `position(email, '@') > 1 AND match(email, '[^ -~]') AND NOT match(email, '[][ <>",;:|()]') AND NOT match(email, '[[:space:]]') AND NOT match(email, '[.!?]$')`
    const classes: Record<string, string[]> = {
      // Stored with at least one upper-case letter, asked in lower case: the rows the text index finds only through its lower() preprocessor.
      mixedCase: await pick(`email != lower(email) AND login_type = 'email' AND match(lower(email), '${ASCII_EMAIL}')`, 35),
      plain: await pick(`email = lower(email) AND login_type = 'email' AND match(email, '${ASCII_EMAIL}')`, 25),
      punctuation: await pick(`login_type = 'email' AND match(lower(email), '^[a-z0-9._+-]*[+_-][a-z0-9._+-]*@[a-z0-9-]+([.][a-z0-9-]+)+$')`, 12),
      digitsOnly: await pick(`login_type = 'email' AND match(email, '^[0-9]{5,12}@[a-z0-9-]+([.][a-z0-9-]+)+$')`, 4),
      nonAscii: await pick(plainNonAscii, 8),
    }
    const absent = Array.from({ length: 8 }, (_, i) => `zz-absent-${Date.now()}-${i}@no-such-host.invalid`)
    classes.absent = absent
    const all = Array.from(new Set(Object.values(classes).flat()))
    const counts = Object.entries(classes).map(([k, v]) => `${k}=${v.length}`).join(' ')
    expect(classes.mixedCase.length, 'mixed-case addresses were sampled').toBeGreaterThan(5)

    // The oracle: one query per address, the bloom filter on lower(email) only.
    const oracle = new Map<string, string[]>()
    for (const v of all) {
      const rows = await executeQuery(
        `SELECT email, password, url, domain, source_file, imported_at FROM ulp.credentials WHERE lower(email) = lower({v:String})
         ORDER BY imported_at DESC LIMIT 1000 SETTINGS max_execution_time = 60, optimize_use_projections = 0`, { v }) as Array<Record<string, string>>
      oracle.set(v, digest(rows))
    }
    const comparable = all.filter(v => oracle.get(v)!.length <= 50) // the batch caps an address at 50 rows
    const mixedRows = comparable.reduce((n, v) => n + (oracle.get(v)!.filter(line => { const email = line.split('\u0001')[0]; return email !== email.toLowerCase() }).length), 0)
    expect(mixedRows, 'the oracle holds rows stored in mixed case, so the comparison is not vacuous').toBeGreaterThan(0)

    const lines = [`sampled: ${counts}; compared ${comparable.length} of ${all.length} (the rest hold more than 50 rows); mixed-case stored rows compared: ${mixedRows}`]
    for (const route of ROUTES) {
      const answer = await ask(route, { emails: comparable })
      expect(answer.status).toBe(200)
      let mismatches = 0
      for (const v of comparable) {
        const got = digest(answer.results[v].results)
        const want = oracle.get(v)!
        if (got.length !== want.length || got.some((line, i) => line !== want[i])) mismatches++
      }
      lines.push(`${route.padEnd(8)} ${comparable.length} addresses in one batch: ${answer.ms} ms, rows differing from the per-address oracle: ${mismatches}`)
      expect(mismatches, `${route}: the batch equals the oracle for every address`).toBe(0)
    }
    console.log(`\n=== parity (values withheld) ===\n${lines.join('\n')}\n`)
  }, 1_800_000)

  test('the words of the index hint are what ClickHouse\'s own index tokenizer cuts, on 200,000 real ASCII logins', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { prefilterWords, asciiLower } = await import('@/lib/batch-input')
    const rows = await executeQuery(
      `SELECT email, tokens(lower(email), 'splitByNonAlpha') AS t FROM ulp.credentials
       WHERE _partition_id = '202610' AND cityHash64(email) % 2000 = 0 AND NOT match(email, '[^ -~]') LIMIT 200000 ${SAMPLE}`, {}) as Array<{ email: string; t: string[] }>
    expect(rows.length, 'a sample of logins').toBeGreaterThan(50_000)
    let different = 0
    let tested = 0
    for (const { email, t } of rows) {
      const words = prefilterWords(asciiLower(email))
      if (words === null) { if (t.length > 0 && t.every(w => w.length <= 64)) different++; continue }
      tested++
      const index = new Set(t)
      // Every word of the hint must be a token of the index; when the login has at most 8 words, the sets are equal.
      if (!words.every(w => index.has(w)) || (index.size <= 8 && words.length !== index.size)) different++
    }
    console.log(`\n=== tokenizer parity ===\nlogins: ${rows.length}, hints built: ${tested}, logins where the hint's words differ from the index tokens: ${different}\n`)
    expect(different).toBe(0)
  }, 600_000)

  test('single lookup: GET /api/v1/lookup?domain= finds the entry in every pasted shape, with exactly the rows of the bare host', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const domainRows = await executeQuery(
      `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
       GROUP BY domain HAVING count() BETWEEN 3 AND 40 ORDER BY rand() LIMIT 1 ${SAMPLE}`, {}) as Array<{ domain: string }>
    expect(domainRows.length, 'a sample domain exists').toBe(1)
    const D = domainRows[0].domain

    const base = await askSingle(D)
    expect(base.status).toBe(200)
    expect(base.json.found, 'the bare host is found (the control)').toBe(true)
    expect(base.json, 'a bare host is answered in its old shape').not.toHaveProperty('searched_as')
    expect(Object.keys(base.json)).toEqual(['success', 'found', 'domain', 'count', 'results'])
    const want = digest(base.json.results!)

    const lines: string[] = [`single   d0 bare host (control)       status=${base.status} found=${base.json.found} count=${base.json.count} ${base.ms} ms`]
    for (const [label, value] of domainShapesOf(D).slice(1)) {
      const a = await askSingle(value)
      lines.push(`single   ${label.padEnd(28)} status=${a.status} found=${a.json.found} count=${a.json.count} ${a.ms} ms`)
      expect(a.status, label).toBe(200)
      expect(a.json.found, label).toBe(true)
      expect(digest(a.json.results!), `${label}: exactly the rows of the bare host`).toEqual(want)
      // searched_as says what was looked up whenever that is not what was typed; padding alone is not a difference.
      if (label.startsWith('d8')) expect(a.json, label).not.toHaveProperty('searched_as')
      else expect(a.json.searched_as, label).toBe(D)
    }
    console.log(`\n=== single lookup, pasted shapes (values withheld) ===\n${lines.join('\n')}\n`)
  }, 600_000)

  test('single lookup PARITY: the rows are those of one `domain = value` query per value the entry stands for; none the old exact comparison found is lost', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { domainEntry } = await import('@/lib/batch-input')
    type Row = Record<string, string>
    // The old route's query, one value at a time: the oracle (a primary-key equality, no IN list, no cleaning).
    const exact = async (value: string): Promise<Row[]> => await executeQuery(
      `SELECT url, email, domain, source_file, imported_at FROM ulp.credentials WHERE domain = {v:String}
       ORDER BY imported_at DESC LIMIT 100 SETTINGS max_execution_time = 60`, { v: value }) as Row[]
    const distinctDomains = async (where: string, n: number): Promise<string[]> => (await executeQuery(
      `SELECT domain FROM ulp.credentials WHERE ${where} LIMIT 1 BY domain LIMIT ${n} ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain)

    // Domains as they are stored. The old parser left a `www.` (4,605 rows), a `:port` (226,642) or a `/path` (1.37 million) on some; those are the
    // values an exact comparison matched and a cleaner must not lose. The legacy shapes are taken from the first granules that hold them (early exit).
    const classes: Record<string, string[]> = {
      clean: (await executeQuery(
        `SELECT domain FROM ulp.credentials WHERE imported_at > now() - INTERVAL 30 DAY AND NOT startsWith(domain, 'www.') AND match(domain, '${HOST}')
         GROUP BY domain HAVING count() BETWEEN 1 AND 30 ORDER BY rand() LIMIT 12 ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain),
      withWww: (await executeQuery(
        `SELECT domain FROM ulp.credentials WHERE startsWith(domain, 'www.') GROUP BY domain HAVING count() BETWEEN 1 AND 30 ORDER BY rand() LIMIT 12 ${SAMPLE}`, {}) as Array<{ domain: string }>).map(r => r.domain),
      withPort: await distinctDomains(`match(domain, '^[a-z0-9.-]+:[0-9]+$')`, 12),
      withPath: await distinctDomains(`match(domain, '^[a-z0-9.-]+/')`, 12),
    }
    const counts = Object.entries(classes).map(([k, v]) => `${k}=${v.length}`).join(' ')

    const lines = [`sampled: ${counts}`]
    for (const [name, values] of Object.entries(classes)) {
      let compared = 0, skipped = 0, rowsCompared = 0, mismatches = 0, oldRows = 0, lost = 0, grew = 0
      for (const value of values) {
        const stands = domainEntry(value).candidates
        const perValue = new Map<string, Row[]>()
        for (const c of stands) perValue.set(c, await exact(c))
        // What the OLD route compared: the text as typed, lower-cased and trimmed. Fetched with its own query, whatever the candidates are.
        const asBefore = value.toLowerCase().trim()
        const before = perValue.get(asBefore) ?? await exact(asBefore)
        const lists = [...Array.from(perValue.values()), before]
        if (lists.some(rows => rows.length >= 100) || Array.from(perValue.values()).reduce((n, rows) => n + rows.length, 0) >= 100) {
          skipped++ // at the cap, ties in imported_at make the cut arbitrary
          continue
        }
        const answer = await askSingle(value)
        expect(answer.status, `${name}: status`).toBe(200)
        const got = digest(answer.json.results ?? [])
        const want = digest(Array.from(perValue.values()).flat())
        compared++
        rowsCompared += want.length
        if (got.length !== want.length || got.some((line, i) => line !== want[i])) mismatches++
        // Every row the old comparison returned must be in the new answer (as a multiset).
        const old = digest(before)
        oldRows += old.length
        const have = new Map<string, number>()
        for (const line of got) have.set(line, (have.get(line) ?? 0) + 1)
        for (const line of old) { const n = have.get(line) ?? 0; if (n === 0) lost++; else have.set(line, n - 1) }
        if (got.length > old.length) grew++
      }
      lines.push(`${name.padEnd(8)} compared ${compared}, skipped at the cap ${skipped}; rows in the answers ${rowsCompared}, rows the old comparison found ${oldRows}; answers differing from the per-value oracle ${mismatches}, old rows missing ${lost}, answers with more rows than before ${grew}`)
      expect(mismatches, `${name}: the answer is the union of the exact queries`).toBe(0)
      expect(lost, `${name}: no row the old exact comparison found is lost`).toBe(0)
      expect(compared, `${name}: the comparison is not vacuous`).toBeGreaterThan(0)
      expect(oldRows, `${name}: the old comparison found rows to lose`).toBeGreaterThan(0)
      if (name === 'clean') expect(grew, 'clean: a bare host is answered exactly as before').toBe(0)
    }
    console.log(`\n=== single lookup parity (values withheld) ===\n${lines.join('\n')}\n`)
  }, 900_000)
})
