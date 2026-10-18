/**
 * End-to-end rehearsal of the whole pipeline in an ISOLATED stack (docker-compose.rehearsal.yml): a fresh ClickHouse built from
 * the production init SQL, the app, and a webhook receiver. It shares nothing with the real stack. What it proves, in order:
 *
 *   1. a fresh install comes up WITHOUT the app being restarted: the init SQL is accepted, the app waits for the real server, every DDL
 *      migration runs (all skip indexes the migrations own exist), country_tier reads email_domain (v26) and
 *      proj_imported_desc carries is_noise and content_key_hash (v27);
 *   2. the admin can log in; a webhook can be saved and its Test button reaches a receiver on the Docker network, signed;
 *   3. a monitor + a file dropped in the inbox -> parsed -> inserted -> in-process match -> webhook delivered, signed, with
 *      a success row in monitor_alerts; the ingest policy holds (a T3 row is dropped, a login with no "@" is not tiered);
 *   4. rows that appear in ClickHouse WITHOUT passing through the importer (what the legacy-row repair does) are found by the
 *      scheduled rescan and delivered ("[scheduled-rescan]"), and nothing is left in webhook_outbox;
 *   5. scripts/repair-scheme-split-rows.sh runs for real against this stack: it appends the one repairable legacy row that
 *      was not already there (original imported_at / source_file, real domain), skips the credential that already existed, the
 *      T3 row and the too-short password, leaves the legacy rows alone, drops its scratch table, and a second run appends nothing;
 *   6. the Credentials Browser's "Newest first" runs as time windows on proj_imported_desc (lib/newest-first.ts), end to end.
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
import { MIGRATION_INDEXES } from '@/lib/clickhouse-migration-safety'

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
    // temporary one too, so compose starts the app while the real server may not listen yet. The app is NOT restarted here: it has to
    // wait for the server itself (lib/clickhouse-migration-safety.ts), exactly as on a first start after a disaster recovery. This script
    // used to restart it, which hid the gap: the migrations then failed with ECONNREFUSED, were recorded as done, and left nine skip indexes out.
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
    const appUp = await waitFor('app healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000)
    check('the app came up on its own, without a restart', !!appUp)
    if (!appUp) return 1
    const ddlRecorded = () => appNode(`const D=require('better-sqlite3');const db=new D('/app/data/ulp.db',{readonly:true});const r=db.prepare("SELECT value FROM app_settings WHERE key_name='ch_ddl_version'").get();console.log(r?r.value:'')`)
    const migrated = await waitFor('the DDL version recorded', () => ddlRecorded() === '29', 180_000, 3000)
    check('the app ran its DDL migrations on the empty database', !!migrated)
    if (!migrated) return 1

    check('ulp.credentials exists', chQuery("SELECT count() FROM system.tables WHERE database='ulp' AND name='credentials'") === '1')
    const expr = chQuery("SELECT default_expression FROM system.columns WHERE database='ulp' AND table='credentials' AND name='country_tier'")
    check('country_tier reads email_domain (DDL v26 / the init SQL)', expr.includes('email_domain') && !expr.includes("splitByChar('@', lower(email))"))
    const ddl = appNode(`const D=require('better-sqlite3');const db=new D('/app/data/ulp.db',{readonly:true});console.log(db.prepare("SELECT value FROM app_settings WHERE key_name='ch_ddl_version'").get().value)`)
    check('the DDL version recorded in SQLite is 29 (v29: the lower(email) index)', ddl === '29', `got ${ddl}`)
    const addressIndex = chQuery("SELECT expr FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'")
    check('idx_bf_email_lc exists on a fresh install and indexes lower(email)', addressIndex === 'lower(email)', `got ${addressIndex}`)
    const owned = MIGRATION_INDEXES.map((i) => i.name).sort()
    const owns = chQuery(`SELECT arrayStringConcat(arraySort(groupArray(name)), ',') FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name IN (${owned.map((n) => `'${n}'`).join(',')})`)
    check(`all ${owned.length} skip indexes only the migrations create exist on a fresh install`, owns === owned.join(','), `got ${owns}`)
    const indexCount = chQuery("SELECT count() FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials'")
    check('ulp.credentials has 20 skip indexes in all (11 from the init SQL, 9 from the migrations)', indexCount === '20', `got ${indexCount}`)
    const migrationLog = sh('sh', ['-c', `docker logs ${APP} 2>&1 | grep -F '[ClickHouse migration]' || true`], env)
    const migrationProblems = migrationLog.split('\n').filter((l) => /FAILED|was missing/.test(l))
    check('the migration log reports no failure and no missing index', migrationProblems.length === 0, migrationProblems.slice(0, 2).join(' | ').slice(0, 300))
    console.log(`  info: ${migrationLog.includes('not accepting connections yet') ? 'the app found the server not listening yet and waited for it' : 'the server was already listening when the app started (the first-start race did not happen this time)'}`)
    const sourcesCols = chQuery("SELECT arrayStringConcat(arraySort(groupArray(name)), ',') FROM system.columns WHERE database='ulp' AND table='sources' AND name IN ('size','sha256','archive_id')")
    check('ulp.sources has the identity columns (DDL v28 / the init SQL)', sourcesCols === 'archive_id,sha256,size', `got ${sourcesCols}`)
    const projCurrent = chQuery("SELECT count() FROM system.projections WHERE database = 'ulp' AND table = 'credentials' AND name = 'proj_imported_desc' AND position(query, 'is_noise') > 0 AND position(query, 'content_key_hash') > 0")
    check('proj_imported_desc carries is_noise and content_key_hash (DDL v27 / the init SQL)', projCurrent === '1', `count ${projCurrent}`)

    // 1b. The start-up safeguards against a REAL server: ClickHouse is down when the app starts (the app has to wait for it, not record anything), and an
    // index the migrations own has been lost (the schema check has to add it back). Both happen on the next start of the same app, with its DDL version already at 29.
    console.log('1b. Start-up with ClickHouse down and an index lost')
    chQuery('ALTER TABLE ulp.credentials DROP INDEX idx_inv_url')
    check('the index is gone before the restart (the drift is real)', chQuery("SELECT count() FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_inv_url'") === '0')
    sh('docker', ['stop', CH], env)
    const restartedAt = new Date().toISOString() // only what this start logs counts, not the first start's lines
    sh('docker', ['restart', APP], env)
    const waitSeen = await waitFor('the app waiting for ClickHouse', () => sh('sh', ['-c', `docker logs --since ${restartedAt} ${APP} 2>&1 | grep -c 'not accepting connections yet' || true`], env) !== '0', 90_000, 2000)
    check('the app started with ClickHouse down and says it is waiting for it, instead of running its DDL', !!waitSeen)
    const ddlWhileDown = sh('sh', ['-c', `docker logs --since ${restartedAt} ${APP} 2>&1 | grep -c 'DDL v29 already applied' || true`], env)
    check('no DDL step ran while ClickHouse was down', ddlWhileDown === '0')
    sh('docker', ['start', CH], env)
    const schemaChecked = await waitFor('the schema check after the start', () => sh('sh', ['-c', `docker logs --since ${restartedAt} ${APP} 2>&1 | grep -c 'was missing 1 skip index' || true`], env) !== '0', 240_000, 3000)
    check('once ClickHouse answered, the app ran on and the schema check named the missing index', !!schemaChecked)
    const indexBack = chQueryOrEmpty("SELECT count() FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_inv_url'")
    check('idx_inv_url was added back by the schema check', indexBack === '1', `got ${indexBack}`)
    check('the recorded DDL version is still 29', ddlRecorded() === '29')
    const appHealthy1b = await waitFor('app healthy again', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy', 300_000)
    check('the app is healthy again after the restart', !!appHealthy1b)
    if (!appHealthy1b) return 1

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
        'https://portal.example.com/in:carol@rediffmail.com:T3-Pa55-four',   // India: T3 and not on the hard-keep list
      ].join('\n') + '\n',
    )
    const imported = await waitFor('3 rows imported', () => chQuery('SELECT count() FROM ulp.credentials') === '3', 120_000, 3000)
    check('the file was imported: 3 rows (the T3 row was dropped by the ingest policy)', !!imported, `rows: ${chQuery('SELECT count() FROM ulp.credentials')}`)
    check('the T3 login is not stored', chQuery("SELECT count() FROM ulp.credentials WHERE email = 'carol@rediffmail.com'") === '0')
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
      insertRow('https', `//${DOMAIN}/portal`, `frank@${DOMAIN}|Pa55-six`, '', 'legacy-b.txt'), // the same credential, staged twice
      insertRow('https', '//shop.example.com/x', 'gina|ab', '', 'legacy.txt'), // password too short
      insertRow('https', '//site.example.in/login', 'x@rediffmail.com|Secret-Pa55', '', 'legacy.txt'), // T3 (India, not on the hard-keep list) once corrected
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
    check('the dry run finds the 5 legacy rows, would repair 3, and changes nothing', dry.status === 0 && /candidates:\s+5/.test(dry.stdout) && /repaired:\s+3/.test(dry.stdout) && count("source_file LIKE 'legacy%'") === '5', (dry.stdout + dry.stderr).slice(-200))
    const first = wrapper(true)
    // 3 rows are staged but 2 distinct credentials, and one of them (staged twice) is already in the table: the figures are DISTINCT credentials
    check('APPLY=1 appends exactly the one repairable row that was not already there', first.status === 0 && /already in ulp.credentials \(skipped\): 1\b/.test(first.stdout) && /appended: 1 repaired/.test(first.stdout), (first.stdout + first.stderr).slice(-300))
    check('...with its original imported_at and source_file and a real domain', count(`url = 'https://docs.example.com/y' AND email = 'hank@example.com' AND password = 'Pa55-seven' AND domain = 'docs.example.com' AND source_file = 'legacy.txt' AND imported_at = '${stamp}'`) === '1')
    check('the credential that already existed was not duplicated', count(`email = 'frank@${DOMAIN}' AND url = 'https://${DOMAIN}/portal'`) === '1')
    check('the T3 row and the too-short password were not appended', count("email = 'x@rediffmail.com'") === '0' && count("url = 'https://shop.example.com/x'") === '0')
    check('the five legacy rows are untouched', count("source_file LIKE 'legacy%' AND domain = ''") === '5')
    check('the scratch table is gone', chQuery("SELECT count() FROM system.tables WHERE database = 'ulp' AND name = 'zz_scheme_split_repaired'") === '0')
    const second = wrapper(true)
    check('a second run appends nothing', second.status === 0 && /appended: 0 repaired/.test(second.stdout), (second.stdout + second.stderr).slice(-300))
    check('...and the row count is unchanged', count("url = 'https://docs.example.com/y'") === '1')

    console.log('6. "Newest first" as time windows on proj_imported_desc (lib/newest-first.ts)')
    const newest = await api('GET', '/api/credentials?sort=imported_desc&limit=10&skip_totals=1&exclude_noise=1&dedupe=1')
    check('the Credentials Browser answers a newest-first request', newest.status === 200 && newest.json?.success === true && Array.isArray(newest.json?.results) && newest.json.results.length > 0, `status ${newest.status}`)
    check('...the response says the windows answered it (plan: "windows")', newest.json?.plan === 'windows', `plan: ${newest.json?.plan}`)
    chQuery('SYSTEM FLUSH LOGS')
    // system.query_log holds the query with its {name:Type} parameters already substituted, so the window is recognised by its
    // predicate on the projection's key expression, which no other query of the app contains.
    // (Whether ClickHouse answers a window from the projection is NOT checked here: on a table of a handful of rows the planner reads the
    // base table, as it should. That the projection answers at scale is what the rebuild script's probe and the live parity test verify.)
    const windowedRuns = chQuery("SELECT count() FROM system.query_log WHERE type = 'QueryFinish' AND position(query, 'negate(toUnixTimestamp(imported_at)) <') > 0 AND position(query, 'system.query_log') = 0")
    check('...ClickHouse ran windowed queries on the projection key', Number(windowedRuns) >= 1, `windowed queries in system.query_log: ${windowedRuns}`)
  } catch (err) {
    check('the rehearsal ran without an unexpected error', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  } finally {
    if (keep) {
      console.log(`\nStack left running (--keep). App: ${BASE}. Remove it with (the compose file wants these set even to stop the stack):\n  REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
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
