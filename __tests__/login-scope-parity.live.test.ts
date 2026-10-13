import { execSync } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

/**
 * LIVE parity check for the login search scope (lib/ulp-search.ts): the route's counts must equal references written differently from the code under
 * test. Skipped unless LSP_PARITY=1; it talks to the real ClickHouse (the running ulpsuite_clickhouse container) and prints timings. READ-ONLY.
 * It drives the real GET /api/credentials handler (totals_only, dedupe=0, so raw_total is the plain count of the search).
 *
 *   whole word    has(splitByNonAlpha(lower(email)), w)           the tokenizer as a plain function, no index; within 0.01% (a handful of logins
 *                                                                 with a "~" next to the word are cut differently by the index)
 *   dotted name   every word whole, then position(lower(email), phrase) > 0
 *   contains      position(lower(email), lower(w)) > 0
 *   casing probe  at least what `email = lower(address)` finds, at most what `lower(email) = address` finds (the complete answer)
 *
 *   LSP_PARITY=1 npx vitest run __tests__/login-scope-parity.live.test.ts
 *   LSP_PARITY=1 LSP_TERMS=term1,term2 LSP_DOTTED=a.b LSP_ADDRESSES=5 npx vitest run __tests__/login-scope-parity.live.test.ts
 *
 * Real search terms belong in YOUR environment (LSP_TERMS), never in this file: the repository is public. The addresses are picked from the table
 * itself and never printed.
 */
const LIVE = process.env.LSP_PARITY === '1'
const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(',').map(s => s.trim()).filter(Boolean)
const WORDS = list(process.env.LSP_TERMS, 'maria,smith,zzqxnonexistent')
const DOTTED = list(process.env.LSP_DOTTED, 'john.smith')
const ADDRESSES = Number(process.env.LSP_ADDRESSES ?? 3)

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

const SETTINGS = 'SETTINGS use_query_cache = 0, use_query_condition_cache = 0, max_execution_time = 900'

async function routed(qs: string): Promise<{ rawTotal: number; ms: number }> {
  const { GET } = await import('@/app/api/credentials/route')
  const { NextRequest } = await import('next/server')
  const { getClient } = await import('@/lib/clickhouse')
  await getClient().command({ query: 'SYSTEM DROP QUERY CACHE' })
  await getClient().command({ query: 'SYSTEM DROP QUERY CONDITION CACHE' })
  const t0 = Date.now()
  const res = await GET(new NextRequest(`http://localhost/api/credentials?${qs}&totals_only=1&dedupe=0`))
  const ms = Date.now() - t0
  const body = await res.json()
  expect(body.success, JSON.stringify(body).slice(0, 300)).toBe(true)
  return { rawTotal: Number(body.raw_total), ms }
}

async function reference(where: string, params: Record<string, unknown> = {}): Promise<number> {
  const { getClient } = await import('@/lib/clickhouse')
  const rs = await getClient().query({ query: `SELECT count() AS n FROM ulp.credentials WHERE ${where} ${SETTINGS}`, query_params: params, format: 'JSONEachRow' })
  const rows = (await rs.json()) as Array<{ n: string }>
  return Number(rows[0].n)
}

const words = (v: string) => v.replace(/[A-Z]+/g, m => m.toLowerCase()).match(/[a-z0-9\u0080-￿]+/g) ?? []

describe.skipIf(!LIVE)('login search scope parity on the live table', () => {
  test.each(WORDS)('whole word %s equals the plain tokenizer, with the prefix and with the scope', async w => {
    const viaScope = await routed(`q=${encodeURIComponent(w)}&scope=login`)
    const viaPrefix = await routed(`q=${encodeURIComponent('login:' + w)}`)
    const ref = await reference('has(splitByNonAlpha(lower(email)), {w:String})', { w: w.toLowerCase() })
    console.log(`whole word | ${w.length} chars | route ${viaScope.rawTotal} in ${viaScope.ms} ms | reference ${ref}`)
    expect(viaPrefix.rawTotal).toBe(viaScope.rawTotal)
    expect(Math.abs(viaScope.rawTotal - ref)).toBeLessThanOrEqual(Math.ceil(ref * 0.0001))
  }, 30 * 60_000)

  test.each(DOTTED)('dotted name %s equals the whole-words-then-phrase reference', async v => {
    const r = await routed(`q=${encodeURIComponent(v)}&scope=login`)
    const ref = await reference('arrayAll(x -> has(splitByNonAlpha(lower(email)), x), {ws:Array(String)}) AND position(lower(email), lower({v:String})) > 0', { ws: words(v), v })
    console.log(`dotted | route ${r.rawTotal} in ${r.ms} ms | reference ${ref}`)
    expect(r.rawTotal).toBe(ref)
  }, 30 * 60_000)

  test.each(WORDS)('contains %s equals position(lower(email))', async w => {
    const r = await routed(`q=${encodeURIComponent(w)}&scope=login_contains`)
    const ref = await reference('position(lower(email), lower({w:String})) > 0', { w })
    console.log(`contains | ${w.length} chars | route ${r.rawTotal} in ${r.ms} ms | reference ${ref}`)
    expect(r.rawTotal).toBe(ref)
  }, 30 * 60_000)

  test('Login (contains), Newest first: every row of the page really contains the term', async () => {
    const { GET } = await import('@/app/api/credentials/route')
    const { NextRequest } = await import('next/server')
    const w = WORDS[0]
    const t0 = Date.now()
    const res = await GET(new NextRequest(`http://localhost/api/credentials?q=${encodeURIComponent(w)}&scope=login_contains&sort=imported_desc&limit=50&skip_totals=1&dedupe=0`))
    const body = await res.json()
    console.log(`contains page | plan ${body.plan} | ${body.results?.length} rows in ${Date.now() - t0} ms`)
    expect(body.success).toBe(true)
    for (const row of body.results) expect(String(row.email).toLowerCase()).toContain(w.toLowerCase())
  }, 30 * 60_000)

  test('the address casing probe finds at least the lowercase lookup and at most the complete answer', async () => {
    const { getClient } = await import('@/lib/clickhouse')
    const rs = await getClient().query({
      query: `SELECT DISTINCT lower(email) AS a FROM ulp.credentials WHERE _partition_id = '202610' AND position(email, '@') > 0 AND email != lower(email) AND cityHash64(email) % 20000 = 7 LIMIT {n:UInt32}`,
      query_params: { n: ADDRESSES }, format: 'JSONEachRow',
    })
    const addresses = ((await rs.json()) as Array<{ a: string }>).map(r => r.a)
    expect(addresses.length).toBeGreaterThan(0)
    for (const a of addresses) {
      const before = await reference('email = {a:String}', { a })
      const probe = await routed(`q=${encodeURIComponent(a)}`)
      const complete = await reference('lower(email) = {a:String}', { a })
      console.log(`address | lowercase lookup ${before} | probe ${probe.rawTotal} in ${probe.ms} ms | complete ${complete}`)
      expect(probe.rawTotal).toBeGreaterThanOrEqual(before)
      expect(probe.rawTotal).toBeLessThanOrEqual(complete)
    }
  }, 30 * 60_000)
})
