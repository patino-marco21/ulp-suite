import { execSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

/**
 * LIVE check of lib/login-association.ts against the real ulp.credentials (the running ulpsuite_clickhouse container). READ-ONLY. Skipped unless LA_LIVE=1:
 *
 *   LA_LIVE=1 npx vitest run __tests__/login-association.live.test.ts
 *
 * It needs no values of yours and prints none: it finds (site, password) groups in the table that hold exactly one username and one e-mail address, then checks
 * what the library must be able to say about them, whoever they are:
 *   - the password lookup returns both logins for that password (unless the password is so common that the answer is partial);
 *   - the username's association, pinned to the site, lists the address (and the reverse); and no step fails or hits the 30 s cap.
 * Only counts and timings are printed. The probes come from one slice of the primary key (domains q*), which is 4.6M rows and answers in under a second.
 */
const LIVE = process.env.LA_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

describe.skipIf(!LIVE)('login association on the live table', () => {
  test('a username and an address that share a password on one site find each other, and the password lookup returns both', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const { associateLogin, lookupPassword } = await import('@/lib/login-association')
    const run = (sql: string, params: Record<string, unknown>) => executeQuery(sql, params)

    const groups = (await executeQuery(
      `SELECT domain, password, groupArrayIf(email, login_type = 'username') AS users, groupArrayIf(email, login_type = 'email') AS mails
       FROM ulp.credentials WHERE domain >= 'q' AND domain < 'r' AND length(password) >= 10
       GROUP BY domain, password HAVING length(users) = 1 AND length(mails) = 1 ORDER BY cityHash64(domain, password) LIMIT 12
       SETTINGS max_execution_time = 60`,
      {},
    )) as Array<{ domain: string; password: string; users: string[]; mails: string[] }>
    expect(groups.length, 'the probe slice should hold such groups').toBeGreaterThan(0)

    const stats = { groups: groups.length, passwordChecked: 0, passwordPartial: 0, assocFound: 0, assocHigh: 0, reverseFound: 0, errors: 0, maxMs: 0 }
    for (const g of groups) {
      const user = g.users[0].toLowerCase()
      const mail = g.mails[0].toLowerCase()

      let t = Date.now()
      const pw = await lookupPassword({ password: g.password, type: 'any', limit: 200 }, run)
      stats.maxMs = Math.max(stats.maxMs, Date.now() - t)
      if (pw.partial || pw.hasMore) stats.passwordPartial++
      else {
        stats.passwordChecked++
        const logins = pw.results.map(r => r.login)
        expect(logins).toContain(user)
        expect(logins).toContain(mail)
      }

      t = Date.now()
      const a = await associateLogin({ login: g.users[0], want: 'email', site: g.domain }, run)
      stats.maxMs = Math.max(stats.maxMs, Date.now() - t)
      stats.errors += a.errors.length
      const hit = a.candidates.find(c => c.login === mail)
      if (hit) {
        stats.assocFound++
        if (hit.confidence === 'high') stats.assocHigh++
      }

      const rev = await associateLogin({ login: g.mails[0], want: 'username', site: g.domain }, run)
      stats.errors += rev.errors.length
      if (rev.candidates.some(c => c.login === user)) stats.reverseFound++
    }
    console.log(`login association live: ${JSON.stringify(stats)}`)
    expect(stats.errors).toBe(0)
    expect(stats.maxMs).toBeLessThan(30_000)
    expect(stats.passwordChecked).toBeGreaterThan(0)
    // two logins sharing a rare password on one site are exactly what the strongest signal is for
    expect(stats.assocFound).toBeGreaterThanOrEqual(Math.floor(stats.groups * 0.9))
    expect(stats.reverseFound).toBeGreaterThanOrEqual(Math.floor(stats.groups * 0.9))
    expect(stats.assocHigh).toBeGreaterThanOrEqual(Math.floor(stats.groups * 0.7))
  }, 300_000)
})
