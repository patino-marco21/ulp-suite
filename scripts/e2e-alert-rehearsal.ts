/**
 * End-to-end rehearsal of the whole pipeline in an ISOLATED stack (docker-compose.rehearsal.yml): a fresh ClickHouse built from
 * the production init SQL, the app, and a webhook receiver. It shares nothing with the real stack. What it proves, in order:
 *
 *   1. a fresh install comes up: the init SQL is accepted, every DDL migration runs, country_tier reads email_domain (v26);
 *   2. the admin can log in; a webhook can be saved and its Test button reaches a receiver on the Docker network, signed;
 *   3. a monitor + a file dropped in the inbox -> parsed -> inserted -> in-process match -> webhook delivered, signed, with
 *      a success row in monitor_alerts; the ingest policy holds (a T3 row is dropped, a login with no "@" is not tiered);
 *   4. rows that appear in ClickHouse WITHOUT passing through the importer (what the legacy-row repair does) are found by the
 *      scheduled rescan and delivered ("[scheduled-rescan]"), and nothing is left in webhook_outbox;
 *   5. scripts/repair-scheme-split-rows.sh runs for real against this stack: it appends the one repairable legacy row that
 *      was not already there (original imported_at / source_file, real domain), skips the credential that already existed, the
 *      T3 row and the too-short password, leaves the legacy rows alone, drops its scratch table, and a second run appends nothing.
 *
 *   docker compose build app                   # once: the rehearsal uses the image it produces
 *   npx tsx scripts/e2e-alert-rehearsal.ts     # about 3-4 minutes; --keep leaves the stack up for inspection
 *
 * Needs the app image (ulp-suite-app:latest), Docker, about 6 GiB of free memory and port 3101. Exit 0 when every check passes.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
const RECEIVER = 'ulprehearsal_receiver'
const DOMAIN = 'rehearsal-brand.test'
const MONITOR_NAME = 'Rehearsal Monitor'

const keep = process.argv.includes('--keep')
const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    // execFileSync's message is only "Command failed: ..."; the reason is on stderr.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-6).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 2000): Promise<T | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* not yet */
    }
    await sleep(intervalMs)
  }
  console.log(`  ... gave up waiting for: ${label}`)
  return null
}

const password = () => randomBytes(18).toString('base64url') + 'Aa1!'

async function main(): Promise<number> {
  // ── preflight ───────────────────────────────────────────────────────────────
  try {
    sh('docker', ['image', 'inspect', 'ulp-suite-app:latest'])
  } catch {
    console.error('The app image ulp-suite-app:latest is missing: run `docker compose build app` first.')
    return 2
  }
  if (sh('docker', ['ps', '-aq', '--filter', 'name=ulprehearsal_']) !== '') {
    console.error(`A rehearsal stack already exists. Remove it first:  docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    return 2
  }
  const memAvailKb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0)
  if (memAvailKb < 6 * 1024 * 1024) {
    console.error(`Only ${(memAvailKb / 1048576).toFixed(1)} GiB of memory is available; the rehearsal needs about 6 GiB.`)
    return 2
  }

  const dockerCfg = mkdtempSync(join(tmpdir(), 'rehearsal-docker-'))
  writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore
  const secrets = {
    REHEARSAL_JWT_SECRET: randomBytes(32).toString('hex'),
    REHEARSAL_ADMIN_EMAIL: 'admin@rehearsal.test',
    REHEARSAL_ADMIN_PASSWORD: password(),
    REHEARSAL_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  }
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: dockerCfg, ...secrets }
  const compose = (args: string[]) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], env)
  // --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
  const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
  const chQueryOrEmpty = (sql: string) => {
    try {
      return chQuery(sql)
    } catch {
      return ''
    }
  }
  const appNode = (code: string) => sh('docker', ['exec', APP, '/usr/local/bin/node', '-e', code])
  const receiverLines = () =>
    sh('docker', ['logs', RECEIVER], env)
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, any>)
  const dropInInbox = (name: string, text: string) => sh('docker', ['exec', '-i', APP, 'sh', '-c', `cat > /app/inbox/${name}`], env, text)

  let cookie = ''
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, headers: res.headers }
  }

  try {
    console.log('1. Fresh stack')
    compose(['up', '-d'])
    const chUp = await waitFor('ClickHouse healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', CH]) === 'healthy', 240_000)
    check('ClickHouse started from the production init SQL', !!chUp)
    // The image runs the init SQL on a temporary server, then starts the real one; /ping (the health check) answers on the
    // temporary one too. Wait for the REAL server on its native port, stably, then restart the app so that its DDL migrations
    // run against it and not against a server that is about to be replaced.
    const chStable = await waitFor(
      'ClickHouse answering on its native port',
      async () => {
        for (let i = 0; i < 3; i++) {
          if (chQueryOrEmpty('SELECT 1') !== '1') return false
          await sleep(2000)
        }
        return true
      },
      180_000,
      1000,
    )
    check('the real ClickHouse server is up on its native port after the init SQL ran', !!chStable)
    if (!chUp || !chStable) return 1
    sh('docker', ['restart', APP], env)
    const appUp = await waitFor('app healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000)
    check('the app started and ran its DDL migrations on the empty database', !!appUp)
    if (!appUp) return 1

    check('ulp.credentials exists', chQuery("SELECT count() FROM system.tables WHERE database='ulp' AND name='credentials'") === '1')
    const expr = chQuery("SELECT default_expression FROM system.columns WHERE database='ulp' AND table='credentials' AND name='country_tier'")
    check('country_tier reads email_domain (DDL v26 / the init SQL)', expr.includes('email_domain') && !expr.includes("splitByChar('@', lower(email))"))
    const ddl = appNode(`const D=require('better-sqlite3');const db=new D('/app/data/ulp.db',{readonly:true});console.log(db.prepare("SELECT value FROM app_settings WHERE key_name='ch_ddl_version'").get().value)`)
    check('the DDL version recorded in SQLite is 26', ddl === '26', `got ${ddl}`)

    console.log('2. Login and webhook')
    const login = await api('POST', '/api/auth/login', { email: secrets.REHEARSAL_ADMIN_EMAIL, password: secrets.REHEARSAL_ADMIN_PASSWORD })
    const setCookie = (login.headers as any).getSetCookie?.() as string[] | undefined
    const auth = (setCookie ?? []).map((c) => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
    check('the seeded admin can log in', login.status === 200 && !!auth, `status ${login.status}`)
    if (!auth) return 1
    cookie = `auth=${auth}`

    const bad = await api('POST', '/api/monitoring/webhooks', { name: 'bad', url: 'ftp://example.com/x' })
    check('a non-http webhook URL is refused', bad.status === 400)
    const creds = await api('POST', '/api/monitoring/webhooks', { name: 'bad', url: 'http://user:pw@example.com/x' })
    check('a webhook URL with credentials is refused', creds.status === 400)

    const hook = await api('POST', '/api/monitoring/webhooks', {
      name: 'Rehearsal Receiver', url: `http://${RECEIVER}:9000/hook`, secret: secrets.REHEARSAL_WEBHOOK_SECRET,
    })
    const hookId = hook.json?.data?.id as number | undefined
    check('a webhook to the receiver on the private network is accepted (WEBHOOK_ALLOW_PRIVATE_HOSTS=1 in this stack)', hook.status === 200 && !!hookId, `status ${hook.status}: ${hook.json?.error ?? ''}`)
    if (!hookId) return 1
    const test = await api('POST', `/api/monitoring/webhooks/${hookId}/test`)
    check('the Test button delivers', test.json?.success === true, JSON.stringify(test.json ?? {}).slice(0, 160))
    const testSeen = await waitFor('test delivery at the receiver', () => receiverLines().find((l) => l.is_test), 30_000, 1000)
    check('the receiver got the test payload, correctly signed', !!testSeen && testSeen.signature_ok === true)

    console.log('3. Monitor and import')
    const mon = await api('POST', '/api/monitoring/monitors', {
      name: MONITOR_NAME, domains: [DOMAIN], match_mode: 'both', webhook_ids: [hookId], rescan_mode: 'dedup', rescan_interval_hours: 1,
    })
    const monId = mon.json?.data?.id as number | undefined
    check('a monitor on the synthetic domain is created', mon.status === 200 && !!monId, `status ${mon.status}: ${mon.json?.error ?? ''}`)
    if (!monId) return 1

    dropInInbox(
      'rehearsal-a.txt',
      [
        `https://${DOMAIN}/login:alice@${DOMAIN}:Rehearsal-Pa55-one`,
        'https://shop.example.com/cart:bob@gmail.com:Another-Pa55-two',
        'https://forum.example.com/login:ivan.ru:NoAtSign-Pa55-three',
        'https://portal.example.com/in:carol@mail.ru:T3-Pa55-four',
      ].join('\n') + '\n',
    )
    const imported = await waitFor('3 rows imported', () => chQuery('SELECT count() FROM ulp.credentials') === '3', 120_000, 3000)
    check('the file was imported: 3 rows (the T3 row was dropped by the ingest policy)', !!imported, `rows: ${chQuery('SELECT count() FROM ulp.credentials')}`)
    check('the T3 login is not stored', chQuery("SELECT count() FROM ulp.credentials WHERE email = 'carol@mail.ru'") === '0')
    check('a login with no "@" is NOT labelled T3 (the stored-label bug of 2026-10-01)', chQuery("SELECT country_tier FROM ulp.credentials WHERE email = 'ivan.ru'") === '')

    const alertA = await waitFor(
      'import-time alert at the receiver',
      () => receiverLines().find((l) => l.monitor_name === MONITOR_NAME && l.match_emails?.includes(`alice@${DOMAIN}`)),
      120_000,
      2000,
    )
    check('the import triggered a webhook for the monitor, with the matching login', !!alertA)
    check('...and it was signed with the webhook secret', alertA?.signature_ok === true)
    const alerts = await api('GET', '/api/monitoring/alerts')
    const okRow = JSON.stringify(alerts.json ?? {}).includes('"status":"success"')
    check('monitor_alerts records a successful delivery', alerts.status === 200 && okRow)

    console.log('4. Rows that did not come through the importer (what the legacy-row repair appends)')
    chQuery(
      `INSERT INTO ulp.credentials (url, email, password, domain, source_file) VALUES ('https://${DOMAIN}/admin', 'erin@${DOMAIN}', 'Rehearsal-Pa55-five', '${DOMAIN}', 'repair-simulation.txt')`,
    )
    appNode(
      `const D=require('better-sqlite3');const db=new D('/app/data/ulp.db');db.prepare("UPDATE domain_monitors SET last_triggered_at = datetime('now','-3 hours') WHERE id = ?").run(${monId})`,
    )
    sh('docker', ['restart', APP], env) // the cron's first tick is 30 s after start, and it sees the monitor due
    const appBack = await waitFor('app healthy again', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 180_000)
    check('the app came back after the restart', !!appBack)
    const rescan = await waitFor(
      'scheduled-rescan alert at the receiver',
      () => receiverLines().find((l) => l.source_file === '[scheduled-rescan]' && l.match_emails?.includes(`erin@${DOMAIN}`)),
      240_000,
      3000,
    )
    check('the scheduled rescan found the row that never passed through the importer and delivered it', !!rescan)
    check('...signed', rescan?.signature_ok === true)
    const outbox = appNode(`const D=require('better-sqlite3');const db=new D('/app/data/ulp.db',{readonly:true});console.log(db.prepare("SELECT count(*) c FROM webhook_outbox WHERE status != 'delivered'").get().c)`)
    check('nothing is waiting in webhook_outbox', outbox === '0', `rows: ${outbox}`)

    console.log('5. Scheme-split repair (scripts/repair-scheme-split-rows.sh against this stack)')
    const stamp = '2026-07-24 05:14:13'
    const insertRow = (url: string, email: string, password: string, domain: string, file: string) =>
      `('${url}', '${email}', '${password}', '${domain}', '${file}', '', '${stamp}')`
    const legacy = [
      insertRow('https', '//docs.example.com/y', 'hank@example.com|Pa55-seven', '', 'legacy.txt'), // repairable, not there yet
      insertRow('https', `//${DOMAIN}/portal`, `frank@${DOMAIN}|Pa55-six`, '', 'legacy.txt'), // repairable, but the correct copy exists
      insertRow('https', '//shop.example.com/x', 'gina|ab', '', 'legacy.txt'), // password too short
      insertRow('https', '//site.example.ru/login', 'x@mail.ru|Secret-Pa55', '', 'legacy.txt'), // T3 once corrected
    ]
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name, imported_at) VALUES ${legacy.join(', ')}`)
    chQuery(
      `INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name, imported_at) VALUES ${insertRow(`https://${DOMAIN}/portal`, `frank@${DOMAIN}`, 'Pa55-six', DOMAIN, 'other.txt')}`,
    )
    const wrapper = (apply: boolean) =>
      spawnSync('bash', ['scripts/repair-scheme-split-rows.sh'], {
        encoding: 'utf8',
        env: { ...process.env, CLICKHOUSE_CONTAINER: CH, APP_CONTAINER: APP, APPLY: apply ? '1' : '0' },
        timeout: 300_000,
      })
    const count = (where: string) => chQuery(`SELECT count() FROM ulp.credentials WHERE ${where}`)

    const dry = wrapper(false)
    check('the dry run finds the 4 legacy rows, would repair 2, and changes nothing', dry.status === 0 && /candidates:\s+4/.test(dry.stdout) && /repaired:\s+2/.test(dry.stdout) && count("source_file = 'legacy.txt'") === '4', (dry.stdout + dry.stderr).slice(-200))
    const first = wrapper(true)
    check('APPLY=1 appends exactly the one repairable row that was not already there', first.status === 0 && /appended: 1 repaired/.test(first.stdout), (first.stdout + first.stderr).slice(-300))
    check('...with its original imported_at and source_file and a real domain', count(`url = 'https://docs.example.com/y' AND email = 'hank@example.com' AND password = 'Pa55-seven' AND domain = 'docs.example.com' AND source_file = 'legacy.txt' AND imported_at = '${stamp}'`) === '1')
    check('the credential that already existed was not duplicated', count(`email = 'frank@${DOMAIN}' AND url = 'https://${DOMAIN}/portal'`) === '1')
    check('the T3 row and the too-short password were not appended', count("email = 'x@mail.ru'") === '0' && count("url = 'https://shop.example.com/x'") === '0')
    check('the four legacy rows are untouched', count("source_file = 'legacy.txt' AND domain = ''") === '4')
    check('the scratch table is gone', chQuery("SELECT count() FROM system.tables WHERE database = 'ulp' AND name = 'zz_scheme_split_repaired'") === '0')
    const second = wrapper(true)
    check('a second run appends nothing', second.status === 0 && /appended: 0 repaired/.test(second.stdout), (second.stdout + second.stderr).slice(-300))
    check('...and the row count is unchanged', count("url = 'https://docs.example.com/y'") === '1')
  } catch (err) {
    check('the rehearsal ran without an unexpected error', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  } finally {
    if (keep) {
      console.log(`\nStack left running (--keep). App: ${BASE}. Remove it with:\n  docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    } else {
      try {
        compose(['down', '-v', '--remove-orphans'])
      } catch (err) {
        console.log(`  could not tear the stack down: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
      }
    }
    rmSync(dockerCfg, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`)
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(2)
  },
)
