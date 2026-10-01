import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

let impl: () => Promise<unknown[]>
vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(async () => impl()) }))

import { NextRequest } from 'next/server'

type Handler = (req: NextRequest) => Promise<Response>

/** A fresh copy of the route, so every test starts with empty in-memory limiters. */
async function freshRoute(): Promise<Handler> {
  vi.resetModules()
  return (await import('@/app/api/check/route')).GET as Handler
}

let n = 0
function call(GET: Handler, xff?: string, email = `person${++n}@example.com`) {
  return GET(
    new NextRequest(`http://localhost/api/check?email=${encodeURIComponent(email)}`, {
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    }),
  )
}

const savedHops = process.env.TRUST_PROXY_HOPS
beforeEach(() => {
  impl = async () => []
  delete process.env.TRUST_PROXY_HOPS
})
afterEach(() => {
  if (savedHops === undefined) delete process.env.TRUST_PROXY_HOPS
  else process.env.TRUST_PROXY_HOPS = savedHops
})

describe('GET /api/check — nothing in front of the app (the default)', () => {
  test('rotating X-Forwarded-For does not get around the rate limit: all callers share one budget', async () => {
    const GET = await freshRoute()
    const statuses: number[] = []
    for (let i = 0; i < 65; i++) statuses.push((await call(GET, `203.0.${i % 250}.${(i % 200) + 1}`)).status)
    expect(statuses.slice(0, 60).every(s => s === 200)).toBe(true)
    expect(statuses.slice(60).every(s => s === 429)).toBe(true)
  })

  test('a refused call says nothing about the address and carries a retry hint', async () => {
    const GET = await freshRoute()
    for (let i = 0; i < 60; i++) await call(GET, `198.51.100.${i + 1}`)
    const res = await call(GET, '192.0.2.1')
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await res.json()).toMatchObject({ success: false })
  })
})

describe('GET /api/check — behind one reverse proxy (TRUST_PROXY_HOPS=1)', () => {
  beforeEach(() => {
    process.env.TRUST_PROXY_HOPS = '1'
  })

  test('the limit is per client address, keyed on the entry the proxy appended', async () => {
    const GET = await freshRoute()
    // Each call forges a different left-most value; the proxy appended the same real address every time.
    const same = []
    for (let i = 0; i < 12; i++) same.push((await call(GET, `10.9.8.${i + 1}, 203.0.113.9`)).status)
    expect(same.slice(0, 10).every(s => s === 200)).toBe(true)
    expect(same.slice(10)).toEqual([429, 429])
    // Another real address has its own budget.
    expect((await call(GET, '10.9.8.1, 203.0.113.10')).status).toBe(200)
  })

  test('without the proxy entry (header missing or too short) the caller still counts against the shared budget', async () => {
    const GET = await freshRoute()
    const statuses: number[] = []
    for (let i = 0; i < 62; i++) statuses.push((await call(GET)).status)
    expect(statuses.slice(0, 60).every(s => s === 200)).toBe(true)
    expect(statuses.slice(60)).toEqual([429, 429])
  })
})

describe('GET /api/check — lookups in flight are capped, so a burst cannot queue up behind a 30 s ClickHouse query', () => {
  test('the fifth concurrent lookup is turned away with a 503 and a retry hint; capacity returns when the others finish', async () => {
    process.env.TRUST_PROXY_HOPS = '1'
    const GET = await freshRoute()
    const release: Array<() => void> = []
    impl = () => new Promise<unknown[]>(resolve => release.push(() => resolve([])))

    const pending = [1, 2, 3, 4].map(i => call(GET, `203.0.113.${i}`))
    const fifth = await call(GET, '203.0.113.5')
    expect(fifth.status).toBe(503)
    expect(fifth.headers.get('Retry-After')).toBe('5')
    expect(await fifth.json()).toMatchObject({ success: false })
    expect(release).toHaveLength(4) // the fifth never reached ClickHouse

    release.forEach(r => r())
    expect((await Promise.all(pending)).map(r => r.status)).toEqual([200, 200, 200, 200])

    impl = async () => []
    expect((await call(GET, '203.0.113.6')).status).toBe(200)
  })

  test('a lookup that fails still gives its slot back', async () => {
    process.env.TRUST_PROXY_HOPS = '1'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const GET = await freshRoute()
    impl = async () => {
      throw new Error('boom')
    }
    for (let i = 0; i < 6; i++) expect((await call(GET, `203.0.113.${i + 1}`)).status).toBe(500)
  })
})

describe('nothing but lib/client-ip.ts reads a client-address header', () => {
  const root = join(__dirname, '..')
  function files(dir: string): string[] {
    return readdirSync(join(root, dir)).flatMap(name => {
      const rel = join(dir, name)
      const abs = join(root, rel)
      if (statSync(abs).isDirectory()) return files(rel)
      return /\.(ts|tsx)$/.test(name) ? [rel] : []
    })
  }

  test('app/ and lib/ ask lib/client-ip.ts, never the headers themselves', () => {
    const offenders = [...files('app'), ...files('lib')].filter(f => {
      if (f === join('lib', 'client-ip.ts')) return false
      return /x-forwarded-for|x-real-ip/i.test(readFileSync(join(root, f), 'utf8'))
    })
    expect(offenders).toEqual([])
  })
})
