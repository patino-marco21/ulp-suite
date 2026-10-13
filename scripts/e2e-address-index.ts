/**
 * Upgrade-path rehearsal for the case-insensitive address lookup (docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md),
 * against the ISOLATED rehearsal stack (docker-compose.rehearsal.yml: its own ClickHouse, app and volumes; it shares nothing with the real stack).
 *
 * It starts the stack on the PREVIOUS image (before DDL v29), seeds one address stored in five casings plus 1.5M filler rows (one part, about 23
 * granules), upgrades the app to the CANDIDATE image (DDL v29 adds the index definition; the parts written before it do not carry the index),
 * shows that a lookup is already correct but reads everything, runs scripts/materialize-address-index.sh against the rehearsal ClickHouse, and
 * drives the HTTP routes with the address typed in different cases.
 *
 *   docker build -t ulp-suite-app:address-candidate <git archive of the commit under test>
 *   PREVIOUS_IMAGE=ulp-suite-app:latest npx tsx scripts/e2e-address-index.ts       # about 4 minutes; --keep leaves the stack running
 *
 * PREVIOUS_IMAGE must be an image from before DDL v29 (it is required, with no default, so a re-run after the deploy cannot pass vacuously).
 * Exit 0 when every check passes, 1 when one fails, 2 when the rehearsal cannot start.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const BASE = 'http://127.0.0.1:3101'
const APP = 'ulprehearsal_app'
const CH = 'ulprehearsal_clickhouse'
if (!APP.startsWith('ulprehearsal_') || !CH.startsWith('ulprehearsal_') || !BASE.endsWith(':3101')) {
  throw new Error('refusing to run: this script only drives the isolated rehearsal stack')
}

const PREVIOUS_IMAGE = process.env.PREVIOUS_IMAGE ?? ''
const CANDIDATE_IMAGE = process.env.CANDIDATE_IMAGE ?? 'ulp-suite-app:address-candidate'
const keep = process.argv.includes('--keep')
const RUN = randomBytes(4).toString('hex')
// One address, typed here in three ways, stored in five rows with four distinct casings (two rows share one).
const LOWER = `mixed.case.${RUN}@example.test`
const STORED = [LOWER, LOWER, `Mixed.Case.${RUN}@Example.test`, `MIXED.CASE.${RUN}@EXAMPLE.TEST`, `mIxEd.cAsE.${RUN}@example.test`]
const TYPED = [LOWER, `MIXED.CASE.${RUN}@EXAMPLE.TEST`, `Mixed.Case.${RUN}@example.test`]

const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}
const info = (label: string, value: unknown) => console.log(`  INFO  ${label}: ${value}`)

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
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
    } catch { /* not yet */ }
    await sleep(intervalMs)
  }
  console.log(`  ... gave up waiting for: ${label}`)
  return null
}

async function main(): Promise<number> {
  if (!PREVIOUS_IMAGE) {
    console.error('Set PREVIOUS_IMAGE to an image from before DDL v29 (before the deploy: ulp-suite-app:latest).')
    return 2
  }
  for (const image of [PREVIOUS_IMAGE, CANDIDATE_IMAGE]) {
    try { sh('docker', ['image', 'inspect', image]) } catch { console.error(`The image ${image} is missing.`); return 2 }
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
    REHEARSAL_ADMIN_PASSWORD: randomBytes(18).toString('base64url') + 'Aa1!',
    REHEARSAL_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  }
  const envFor = (image: string): NodeJS.ProcessEnv => ({ ...process.env, DOCKER_CONFIG: dockerCfg, REHEARSAL_APP_IMAGE: image, ...secrets })
  const compose = (image: string, args: string[]) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], envFor(image))
  // --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
  const chQuery = (sql: string) => sh('docker', ['exec', CH, 'clickhouse-client', '--async_insert=0', '--query', sql])
  const chOrEmpty = (sql: string) => { try { return chQuery(sql) } catch { return '' } }
  const appHealthy = () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', APP]) === 'healthy'
  /** Selected and initial granules the index reads for an address that cannot exist (EXPLAIN, text form). */
  const granules = (): { selected: number; initial: number } | null => {
    const text = chQuery(`EXPLAIN indexes = 1 SELECT count() FROM ulp.credentials WHERE lower(email) = lower('nobody-${RUN}@invalid.test') SETTINGS optimize_use_projections = 0`)
    const line = text.split('\n').slice(text.split('\n').findIndex(l => l.includes('Name: idx_bf_email_lc'))).find(l => /Granules:/.test(l))
    const m = /Granules:\s*(\d+)\/(\d+)/.exec(line ?? '')
    return m ? { selected: Number(m[1]), initial: Number(m[2]) } : null
  }

  let cookie = ''
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers }
  }
  const login = async () => {
    const res = await api('POST', '/api/auth/login', { email: secrets.REHEARSAL_ADMIN_EMAIL, password: secrets.REHEARSAL_ADMIN_PASSWORD })
    const setCookie = (res.headers as any).getSetCookie?.() as string[] | undefined
    const auth = (setCookie ?? []).map(c => /(?:^|;\s*)auth=([^;]+)/.exec(c)?.[1]).find(Boolean)
    if (res.status !== 200 || !auth) throw new Error(`login failed (${res.status})`)
    cookie = `auth=${auth}`
  }

  try {
    console.log(`1. Stack on the previous image (${PREVIOUS_IMAGE})`)
    compose(PREVIOUS_IMAGE, ['up', '-d'])
    const chUp = await waitFor('ClickHouse healthy', () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', CH]) === 'healthy', 240_000)
    const chStable = await waitFor('ClickHouse on its native port', async () => {
      for (let i = 0; i < 3; i++) { if (chOrEmpty('SELECT 1') !== '1') return false; await sleep(2000) }
      return true
    }, 180_000, 1000)
    check('ClickHouse started from the production init SQL', !!chUp && !!chStable)
    if (!chUp || !chStable) return 1
    sh('docker', ['restart', APP], envFor(PREVIOUS_IMAGE))
    const up1 = await waitFor('app healthy', appHealthy, 300_000)
    check('the previous app started and ran its migrations', !!up1)
    if (!up1) return 1
    const before = chQuery("SELECT count() FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'")
    check('the previous image has no idx_bf_email_lc (this really is the upgrade path)', before === '0', `count ${before}`)
    if (before !== '0') return 2

    console.log('2. Seed: one address in five rows and four casings, plus 1.5M filler rows, as ONE insert = one part (a single part has nothing to merge with, so it stays exactly as written until the script runs)')
    const seedRows = STORED.map((email, i) => `SELECT 'https://site${i}.example.test/login' AS url, '${email}' AS email, 'pw-${i}' AS password, 'site${i}.example.test' AS domain, 'seed-${RUN}' AS source_file, 'Breach-${RUN}-${i}' AS breach_name`).join(' UNION ALL ')
    const filler = `SELECT concat('https://f', toString(number % 50), '.filler.test/'), concat('filler', toString(number), '-${RUN}@mail.test'), 'pw', concat('f', toString(number % 50), '.filler.test'), 'seed-filler-${RUN}', '' FROM numbers(1500000)`
    chQuery(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) ${seedRows} UNION ALL ${filler} SETTINGS max_insert_threads = 1, max_insert_block_size = 5000000, min_insert_block_size_rows = 5000000, min_insert_block_size_bytes = 1000000000`)
    const partCount = chQuery("SELECT count() FROM system.parts WHERE database='ulp' AND table='credentials' AND active")
    check('the seed is one part', partCount === '1', `parts ${partCount}`)
    if (partCount !== '1') return 2

    console.log(`3. Upgrade the app to the candidate image (${CANDIDATE_IMAGE})`)
    compose(CANDIDATE_IMAGE, ['up', '-d', '--no-deps', 'app'])
    const up2 = await waitFor('candidate app healthy', appHealthy, 300_000)
    check('the candidate app started', !!up2)
    if (!up2) return 1
    const logs = sh('docker', ['logs', APP], envFor(CANDIDATE_IMAGE))
    check('the log says DDL v29 applied', /DDL v29 applied/.test(logs))
    check('idx_bf_email_lc is now defined on lower(email)', chQuery("SELECT expr FROM system.data_skipping_indices WHERE database='ulp' AND table='credentials' AND name='idx_bf_email_lc'") === 'lower(email)')
    await login()
    const g0 = granules()
    check('the part written before the upgrade does not carry the index: an impossible address still reads every granule (and there are enough granules to tell)', !!g0 && g0.initial >= 20 && g0.selected === g0.initial, JSON.stringify(g0))
    const early = await api('GET', `/api/check?email=${encodeURIComponent(TYPED[1])}`)
    check('already correct (it scans): /api/check finds all five rows (five breaches) for the UPPERCASE spelling', early.json?.found === true && early.json?.breach_count === 5, JSON.stringify(early.json).slice(0, 200))

    console.log('4. scripts/materialize-address-index.sh against the rehearsal ClickHouse')
    // 25%: the rehearsal table has about 23 granules, so the filter's own 5% false positives are noisy; unmaterialized is still 100%.
    const scriptEnv = { ...process.env, CLICKHOUSE_CONTAINER: CH, MIN_FREE_GIB: '1', ABORT_FREE_GIB: '0', POLL_SECONDS: '2', MAX_SELECTED_PCT: '25', DOCKER_CONFIG: dockerCfg }
    const dry = sh('bash', ['scripts/materialize-address-index.sh'], scriptEnv)
    check('the dry run says so and changes nothing', /dry run/i.test(dry))
    const applied = sh('bash', ['scripts/materialize-address-index.sh'], { ...scriptEnv, APPLY: '1' })
    check('APPLY=1 materializes the index and its own EXPLAIN check passes', /is materialized on every partition/.test(applied), applied.split('\n').slice(-4).join(' | '))
    const g1 = granules()
    check('an impossible address now reads at most 25% of the granules (about 5% is the filter itself)', !!g1 && g1.initial >= 20 && g1.selected * 4 <= g1.initial, JSON.stringify(g1))

    console.log('5. The routes, with the address typed in three ways')
    for (const typed of TYPED) {
      const check1 = await api('GET', `/api/check?email=${encodeURIComponent(typed)}`)
      check(`/api/check finds all five rows (five breaches) for ${typed === LOWER ? 'lowercase' : typed === TYPED[1] ? 'UPPERCASE' : 'Mixed'}`, check1.json?.found === true && check1.json?.breach_count === 5, JSON.stringify(check1.json).slice(0, 160))
      const batch = await api('POST', '/api/lookup/batch', { emails: [typed] })
      const hit = batch.json?.results?.[typed]
      check('/api/lookup/batch returns all five rows in four casings', hit?.count === 5 && new Set(hit.results.map((r: { email: string }) => r.email)).size === 4, JSON.stringify(hit).slice(0, 160))
      const found = await api('GET', `/api/credentials?q=${encodeURIComponent(typed)}&totals_only=1&dedupe=0`)
      check('/api/credentials (all fields) counts five rows', Number(found.json?.raw_total) === 5, JSON.stringify(found.json).slice(0, 160))
      const inLogin = await api('GET', `/api/credentials?q=${encodeURIComponent(typed)}&scope=login&totals_only=1&dedupe=0`)
      check('/api/credentials (Login scope) counts five rows', Number(inLogin.json?.raw_total) === 5, JSON.stringify(inLogin.json).slice(0, 160))
    }
    const related = await api('GET', `/api/related?email=${encodeURIComponent(STORED[3])}&domain=site0.example.test`)
    check('the related panel lists the same login in every casing', related.json?.success === true && related.json?.by_email?.length === 5, JSON.stringify(related.json).slice(0, 200))
    check('the same account is not its own "other" on the domain', related.json?.by_domain?.every((r: { email: string }) => r.email.toLowerCase() !== LOWER) === true)
    const none = await api('GET', `/api/check?email=${encodeURIComponent(`nobody-${RUN}@example.test`)}`)
    check('an address that is not stored is not found', none.json?.found === false)
  } catch (err) {
    check('the rehearsal ran to the end', false, err instanceof Error ? err.message : String(err))
  } finally {
    if (keep) {
      console.log(`\nStack left running (--keep). App: ${BASE}. Remove it with:\n  REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
    } else {
      try { compose(CANDIDATE_IMAGE, ['down', '-v', '--remove-orphans']) } catch (err) { console.error('teardown failed:', err instanceof Error ? err.message : String(err)) }
    }
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => process.exit(code), err => { console.error(err); process.exit(1) })
