import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'

/**
 * LIVE check of the imported window on the three endpoints that gained it (docs/superpowers/specs/2026-10-18-imported-window-ux-design.md) against the
 * real ulp.credentials (the running ulpsuite_clickhouse container). READ-ONLY. Skipped unless IWA_LIVE=1:
 *
 *   IWA_LIVE=1 npx vitest run __tests__/imported-window-api.live.test.ts
 *
 * It needs no values of yours and prints none, only counts, booleans and timings:
 *   - v1 summary for a window: the credentials count, the top 20 domains and the source count equal an independent plain query over the same bounds, the
 *     estimates are within 3% of the exact distinct counts, and a closed window is answered from the cache the second time;
 *   - password lookup: the logins found in a window are exactly the logins an independent query finds in it, and a subset of the unwindowed answer;
 *   - association: a window that covers everything reproduces the unwindowed answer exactly (candidates, confidence, evidence), a window in the future
 *     finds nothing, and a window in the middle never finds a candidate the unwindowed answer does not have.
 *   - "View what this added": for every finished import job since 2026-10-17 the link's window and file select exactly the rows the job wrote (its
 *     `imported` count), read from a COPY of the job log.
 */
vi.mock('@/lib/api-key-auth', () => ({
  withApiKeyAuth: async () => ({ success: true, apiKey: { keyId: 'live-test', role: 'admin' }, rateLimit: { limit: 100, remaining: 99, resetAt: Date.now() + 60_000 } }),
  addRateLimitHeaders: (response: unknown) => response,
  logApiRequest: async () => undefined,
}))

const LIVE = process.env.IWA_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

// The job log is read from a COPY of the app's SQLite (a database in WAL mode is not opened in place). The copy holds the accounts too, so it is removed.
const jobLogCopies: string[] = []
afterAll(() => { for (const dir of jobLogCopies) rmSync(dir, { recursive: true, force: true }) })

const NO_CACHE = 'SETTINGS use_query_cache = 0, max_execution_time = 120'
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace('.000Z', 'Z')

describe.skipIf(!LIVE)('the imported window on the live table', () => {
  test('v1 summary for a window equals a plain query over the same bounds', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { NextRequest } = await import('next/server')
    const { GET } = await import('@/app/api/v1/summary/route')
    const { resetSummaryCache } = await import('@/lib/v1-summary')
    resetSummaryCache()

    const newest = Number(((await executeQuery(`SELECT toUnixTimestamp(max(max_time)) AS t FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active`, {})) as Array<{ t: string }>)[0].t)
    expect(newest).toBeGreaterThan(0)
    const windows: Array<[string, number, number | null]> = [
      ['last hour of data', newest - 3600, null],
      ['closed window below the newest half day', newest - 3 * 86_400, newest - 12 * 3600],
      ['three days, open at the top', newest - 3 * 86_400, null],
    ]

    const report: string[] = []
    for (const [name, lower, upper] of windows) {
      const where = `imported_at > toDateTime(${lower})${upper === null ? '' : ` AND imported_at <= toDateTime(${upper})`}`
      const qs = `?imported_after=${encodeURIComponent(iso(lower))}${upper === null ? '' : `&imported_before=${encodeURIComponent(iso(upper))}`}`

      let t = Date.now()
      const res = await GET(new NextRequest(`http://localhost/api/v1/summary${qs}`))
      const routeMs = Date.now() - t
      const json = await res.json()
      expect(res.status, name).toBe(200)

      t = Date.now()
      const [exact] = (await executeQuery(`SELECT count() AS c, uniqExact(domain) AS d, uniqExact(email) AS e FROM ulp.credentials WHERE ${where} ${NO_CACHE}`, {})) as Array<{ c: string; d: string; e: string }>
      const top = (await executeQuery(`SELECT domain, count() AS n FROM ulp.credentials WHERE ${where} GROUP BY domain ORDER BY n DESC, domain ASC LIMIT 20 ${NO_CACHE}`, {})) as Array<{ domain: string; n: string }>
      const [src] = (await executeQuery(`SELECT count() AS n FROM ulp.sources WHERE ${where}`, {})) as Array<{ n: string }>
      const plainMs = Date.now() - t

      expect(Number(exact.c), `${name}: the window should hold rows, or this proves nothing`).toBeGreaterThan(0)
      expect(json.stats.credentials, `${name}: credentials`).toBe(Number(exact.c))
      expect(json.stats.sources, `${name}: sources`).toBe(Number(src.n))
      expect(json.top_domains.map((r: { domain: string; count: string }) => [r.domain, Number(r.count)]), `${name}: top domains`).toEqual(top.map(r => [r.domain, Number(r.n)]))
      for (const [field, truth] of [['unique_domains', Number(exact.d)], ['unique_emails', Number(exact.e)]] as const) {
        const got = json.stats[field] as number
        expect(Math.abs(got - truth) / Math.max(1, truth), `${name}: ${field} is an estimate within 3% (got ${got}, exact ${truth})`).toBeLessThan(0.03)
      }
      expect(json.imported_after).toBe(iso(lower))
      report.push(`${name}: ${Number(exact.c).toLocaleString('en-US')} rows, route ${routeMs} ms, plain ${plainMs} ms`)

      if (upper !== null) {
        t = Date.now()
        await GET(new NextRequest(`http://localhost/api/v1/summary${qs}`))
        expect(Date.now() - t, `${name}: the second call is served from the cache`).toBeLessThan(250)
      }
    }
    console.log(`summary windows live: ${report.join(' | ')}`)
  }, 600_000)

  test('password lookup in a window finds exactly the logins an independent query finds there', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { lookupPassword } = await import('@/lib/login-association')
    const { importedRangeProjection } = await import('@/lib/imported-range')
    const run = (sql: string, params: Record<string, unknown>) => executeQuery(sql, params)

    const newest = Number(((await executeQuery(`SELECT toUnixTimestamp(max(max_time)) AS t FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active`, {})) as Array<{ t: string }>)[0].t)
    const lower = newest - 3600
    const recent = importedRangeProjection({ lower, upper: null })
    const picks = (await executeQuery(
      `SELECT password FROM ulp.credentials WHERE ${recent.conditions.join(' AND ')} AND login_type = 'email' AND length(password) >= 10
       GROUP BY password HAVING uniqExact(lower(email)) BETWEEN 2 AND 20 ORDER BY cityHash64(password) LIMIT 4 ${NO_CACHE}`,
      recent.params,
    )) as Array<{ password: string }>
    expect(picks.length, 'the newest hour should hold passwords shared by a few logins').toBeGreaterThan(0)

    const stats = { checked: 0, windowed: 0, unwindowed: 0, future: 0 }
    for (const { password } of picks) {
      const all = await lookupPassword({ password, type: 'email', limit: 1000 }, run)
      const inWindow = await lookupPassword({ password, type: 'email', limit: 1000, range: { lower, upper: null } }, run)
      const future = await lookupPassword({ password, type: 'email', limit: 1000, range: { lower: newest + 3600, upper: null } }, run)
      const truth = (await executeQuery(
        `SELECT DISTINCT lower(email) AS login FROM ulp.credentials WHERE password = {p:String} AND login_type = 'email' AND imported_at > toDateTime({a:Int64}) ${NO_CACHE}`,
        { p: password, a: lower },
      )) as Array<{ login: string }>
      if (all.partial || inWindow.partial || all.hasMore) continue
      stats.checked++
      const got = new Set(inWindow.results.map(r => r.login))
      expect([...got].sort()).toEqual(truth.map(r => r.login).sort())
      const everything = new Set(all.results.map(r => r.login))
      for (const login of got) expect(everything.has(login)).toBe(true)
      expect(future.results).toEqual([])
      stats.windowed += got.size
      stats.unwindowed += everything.size
      stats.future += future.results.length
    }
    console.log(`password window live: ${JSON.stringify(stats)}`)
    expect(stats.checked).toBeGreaterThan(0)
  }, 300_000)

  test('association: a window that covers everything changes nothing, the future finds nothing, a middle window only narrows', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { associateLogin } = await import('@/lib/login-association')
    const run = (sql: string, params: Record<string, unknown>) => executeQuery(sql, params)

    const groups = (await executeQuery(
      `SELECT domain, password, groupArrayIf(email, login_type = 'username') AS users, groupArrayIf(email, login_type = 'email') AS mails,
              toUnixTimestamp(max(imported_at)) AS last_ts
       FROM ulp.credentials WHERE domain >= 'q' AND domain < 'r' AND length(password) >= 10
       GROUP BY domain, password HAVING length(users) = 1 AND length(mails) = 1 ORDER BY cityHash64(domain, password) LIMIT 8
       SETTINGS max_execution_time = 60`,
      {},
    )) as Array<{ domain: string; password: string; users: string[]; mails: string[]; last_ts: string }>
    expect(groups.length, 'the probe slice should hold such groups').toBeGreaterThan(0)

    const now = Math.floor(Date.now() / 1000)
    const stats = { groups: groups.length, same: 0, found: 0, futureEmpty: 0, narrowed: 0, errors: 0, maxMs: 0 }
    for (const g of groups) {
      const probe = { login: g.users[0], want: 'email' as const, site: g.domain }
      const plain = await associateLogin(probe, run)
      const t = Date.now()
      const everything = await associateLogin(probe, run, { range: { lower: 0, upper: null } })
      stats.maxMs = Math.max(stats.maxMs, Date.now() - t)
      const future = await associateLogin(probe, run, { range: { lower: now + 3600, upper: null } })
      const middle = await associateLogin(probe, run, { range: { lower: Number(g.last_ts) - 1, upper: null } })
      stats.errors += plain.errors.length + everything.errors.length + future.errors.length + middle.errors.length

      // a window that covers everything is the unwindowed answer: same candidates, same confidence, same evidence, same count
      expect(everything.candidates).toEqual(plain.candidates)
      expect(everything.candidatesTotal).toBe(plain.candidatesTotal)
      expect(everything.loginSites).toEqual(plain.loginSites)
      expect(everything.anchored).toBe(plain.anchored)
      stats.same++
      if (plain.candidates.length > 0) stats.found++

      // the identity of the account does not depend on the window, but nothing can be a candidate in an empty one
      expect(future.loginSites).toEqual(plain.loginSites)
      expect(future.candidates).toEqual([])
      stats.futureEmpty++

      const known = new Set(plain.candidates.map(c => c.login))
      for (const c of middle.candidates) expect(known.has(c.login), 'a windowed candidate must be one the unwindowed answer has').toBe(true)
      stats.narrowed++
    }
    console.log(`association window live: ${JSON.stringify(stats)}`)
    expect(stats.errors).toBe(0)
    expect(stats.found).toBeGreaterThan(0)
    expect(stats.maxMs).toBeLessThan(30_000)
  }, 300_000)
  test('"View what this added": the link of every import job since 2026-10-17 selects exactly the rows that job wrote', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { jobViewHref } = await import('@/lib/imported-window')
    const { parseImportedRange, importedRangeProjection } = await import('@/lib/imported-range')
    const Database = (await import('better-sqlite3')).default

    const dir = mkdtempSync(join(tmpdir(), 'iwa-jobs-'))
    jobLogCopies.push(dir)
    for (const f of ['ulp.db', 'ulp.db-wal', 'ulp.db-shm']) if (existsSync(`${process.cwd()}/data/${f}`)) copyFileSync(`${process.cwd()}/data/${f}`, `${dir}/${f}`)
    const db = new Database(`${dir}/ulp.db`, { readonly: true })
    const jobs = db.prepare(
      `SELECT filename, status, imported, duration_ms, created_at FROM processing_jobs WHERE status = 'done' AND imported > 0 AND created_at >= '2026-10-17 00:00:00' ORDER BY id`,
    ).all() as Array<{ filename: string; status: string; imported: number; duration_ms: number; created_at: string }>
    db.close()
    expect(jobs.length, 'the job log should hold finished imports since the 17th').toBeGreaterThan(0)

    const stats = { jobs: jobs.length, withFile: 0, exactWithFile: 0, windowOnly: 0, exactWindowOnly: 0, bleedRows: 0, mismatches: [] as string[] }
    for (const job of jobs) {
      const href = jobViewHref(job)!
      const sp = new URL(href, 'http://x').searchParams
      const parsed = parseImportedRange({ imported_after: sp.get('imported_after'), imported_before: sp.get('imported_before') })
      if (!parsed.ok) throw new Error(parsed.error)
      const proj = importedRangeProjection(parsed.range)
      const where = proj.conditions.join(' AND ')
      const file = sp.get('source_file')

      const [inWindow] = (await executeQuery(`SELECT count() AS n FROM ulp.credentials WHERE ${where} ${NO_CACHE}`, proj.params)) as Array<{ n: string }>
      stats.windowOnly++
      if (Number(inWindow.n) === job.imported) stats.exactWindowOnly++
      else stats.bleedRows += Math.max(0, Number(inWindow.n) - job.imported)

      if (file !== null) {
        const [mine] = (await executeQuery(`SELECT count() AS n FROM ulp.credentials WHERE ${where} AND source_file = {f:String} ${NO_CACHE}`, { ...proj.params, f: file })) as Array<{ n: string }>
        stats.withFile++
        if (Number(mine.n) === job.imported) stats.exactWithFile++
        else stats.mismatches.push(`job ${job.created_at}: link selects ${mine.n}, the job wrote ${job.imported}`)
      }
    }
    console.log(`job links live: ${JSON.stringify({ ...stats, mismatches: stats.mismatches.length })}`)
    expect(stats.mismatches).toEqual([])
    expect(stats.withFile).toBeGreaterThan(0)
  }, 600_000)
})
