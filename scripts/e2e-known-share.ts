/**
 * Proof of the known-share preflight (docs/superpowers/specs/2026-11-05-known-share-preflight-design.md, Step A) on a real ClickHouse: the ISOLATED rehearsal stack
 * (docker-compose.rehearsal.yml; only its ClickHouse is started, from the production init SQL, so the table and `norm_key_hash` are the real ones).
 *
 * Files whose new share is known by construction are sampled and counted against rows seeded into `ulp.credentials`:
 *   all new            nothing of it is in the table                              -> 100% new
 *   all known          every row is in the table under another source             -> 0% new, flagged LOW YIELD
 *   half               500 rows known, 500 new                                    -> 50% new
 *   look-alike         the same credentials with a `www.` and capitals           -> 0% new (the normalised key, not the exact one)
 *   owned              the rows are in the table under the file's OWN name        -> 100% new (an imported file read again), and its name needs escaping
 * Then the CLI (`scripts/preflight.ts --known`) prints the same figures, the scratch tables are gone, and a ClickHouse that does not answer fails loudly.
 *
 *   npx tsx scripts/e2e-known-share.ts [--keep]
 *
 * It starts the rehearsal ClickHouse when it is not running and removes it afterwards unless --keep (or unless it was already running). Exit 0 when every check
 * passes, 1 when one fails, 2 when the rehearsal cannot start.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSource } from '@/lib/source-archive'
import { escapeTsvField, isLowYield, knownShareCounts, newSharePct, sampleRows, type KnownCounts } from '@/lib/known-share'

const PROJECT = 'ulp-rehearsal'
const COMPOSE_FILE = 'docker-compose.rehearsal.yml'
const CH = 'ulprehearsal_clickhouse'
if (!CH.startsWith('ulprehearsal_')) throw new Error('refusing to run: this script only drives the isolated rehearsal stack')

const keep = process.argv.includes('--keep')
const RUN = randomBytes(4).toString('hex')
const results: Array<{ ok: boolean; label: string }> = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(label: string, ok: boolean, detail = ''): boolean {
  results.push({ ok, label })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  (${detail})` : ''}`)
  return ok
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-6).join(' | ')
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed: ${stderr || (err instanceof Error ? err.message : String(err))}`)
  }
}

async function waitFor(label: string, fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (fn()) return true } catch { /* not yet */ }
    await sleep(2000)
  }
  console.log(`  ... gave up waiting for: ${label}`)
  return false
}

const credential = (tag: string, i: number) => `https://shop${i % 50}.example.test/login:user-${tag}-${i}@mail.test:Pw-${tag}-${i}-Xy!`
const credentialWww = (tag: string, i: number) => `https://WWW.Shop${i % 50}.Example.test/login:USER-${tag}-${i}@MAIL.test:Pw-${tag}-${i}-Xy!`
const textOf = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n'

async function main(): Promise<number> {
  const dockerCfg = mkdtempSync(join(tmpdir(), 'rehearsal-docker-'))
  writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore
  const env: NodeJS.ProcessEnv = {
    ...process.env, DOCKER_CONFIG: dockerCfg,
    // The compose file asks for these even when only ClickHouse starts; none of them is used.
    REHEARSAL_JWT_SECRET: randomBytes(32).toString('hex'), REHEARSAL_ADMIN_EMAIL: 'admin@rehearsal.test',
    REHEARSAL_ADMIN_PASSWORD: randomBytes(18).toString('base64url') + 'Aa1!', REHEARSAL_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  }
  const compose = (args: string[]) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], env)
  const state = () => sh('docker', ['ps', '-a', '--filter', `name=^${CH}$`, '--format', '{{.State}}'])
  const healthy = () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', CH]) === 'healthy'
  // --async_insert=0: the default profile buffers inserts, and this script reads what it wrote straight away.
  const chQuery = (sql: string, inputFile?: string) => {
    const fd = inputFile ? openSync(inputFile, 'r') : undefined
    const r = spawnSync('docker', ['exec', '-i', CH, 'clickhouse-client', '--async_insert=0', '--query', sql], { stdio: [fd ?? 'ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28 })
    if (fd !== undefined) closeSync(fd)
    if (r.status !== 0) throw new Error(`clickhouse-client failed: ${r.stderr.slice(0, 400)}`)
    return r.stdout.trim()
  }

  let weStarted = false
  const work = mkdtempSync(join(tmpdir(), 'known-share-e2e-'))
  try {
    console.log('1. The rehearsal ClickHouse')
    const existing = state()
    if (existing === '') {
      compose(['up', '-d', 'clickhouse'])
      weStarted = true
    } else if (existing !== 'running') {
      console.error(`The rehearsal container exists but is ${existing}. Remove it first:  docker compose -f ${COMPOSE_FILE} -p ${PROJECT} down -v`)
      return 2
    }
    if (!(await waitFor('ClickHouse healthy', healthy, 240_000)) || !(await waitFor('ClickHouse answers', () => chQuery('SELECT 1') === '1', 120_000))) {
      console.error('The rehearsal ClickHouse did not come up.')
      return 2
    }
    check('ClickHouse started from the production init SQL, with norm_key_hash', chQuery(`SELECT count() FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'norm_key_hash'`) === '1')

    console.log('2. Files known by construction, and the rows seeded for them')
    const OWNED = `ow\\ned\tq'uote-${RUN}.txt`
    const files = {
      allNew: { name: `all-new-${RUN}.txt`, text: textOf(1000, i => credential(`${RUN}a`, i)) },
      allKnown: { name: `all-known-${RUN}.txt`, text: textOf(1000, i => credential(`${RUN}b`, i)) },
      half: { name: `half-${RUN}.txt`, text: textOf(500, i => credential(`${RUN}c`, i)) + textOf(500, i => credential(`${RUN}d`, i)) },
      lookalike: { name: `lookalike-${RUN}.txt`, text: textOf(400, i => credentialWww(`${RUN}e`, i)) },
      owned: { name: OWNED, text: textOf(1000, i => credential(`${RUN}f`, i)) },
    }
    const paths: Record<keyof typeof files, string> = { allNew: '', allKnown: '', half: '', lookalike: '', owned: '' }
    for (const key of Object.keys(files) as Array<keyof typeof files>) {
      paths[key] = join(work, files[key].name.replace(/[\\\t']/g, '_'))
      writeFileSync(paths[key], files[key].text)
    }
    // Seed through the importer's own parser: what the table holds is what an import of that text would have stored.
    const seed = async (text: string, sourceFile: string): Promise<number> => {
      const p = join(work, `seed-${randomBytes(3).toString('hex')}.txt`)
      writeFileSync(p, text)
      const rows = await sampleRows(openSource(p), {})
      const tsv = join(work, `seed-${randomBytes(3).toString('hex')}.tsv`)
      writeFileSync(tsv, rows.map(r => [sourceFile, r.url, r.email, r.password].map(escapeTsvField).join('\t') + '\n').join(''))
      chQuery('INSERT INTO ulp.credentials (source_file, url, email, password) FORMAT TSV', tsv)
      return rows.length
    }
    const seeded = [
      await seed(files.allKnown.text, `other-${RUN}.txt`),
      await seed(textOf(500, i => credential(`${RUN}c`, i)), `other-${RUN}.txt`),
      await seed(textOf(400, i => credential(`${RUN}e`, i)), `other-${RUN}.txt`),
      await seed(files.owned.text, OWNED),
    ]
    check('the table holds the seeded rows', seeded.join(',') === '1000,500,400,1000', seeded.join(','))

    console.log('3. The counts')
    const order = ['allNew', 'allKnown', 'half', 'lookalike', 'owned'] as const
    const samples: Array<{ name: string; rows: Awaited<ReturnType<typeof sampleRows>> }> = []
    for (const key of order) {
      const source = openSource(paths[key])
      samples.push({ name: key === 'owned' ? OWNED : source.name, rows: await sampleRows(source, {}) })
    }
    const counts = knownShareCounts(samples, { container: CH })
    const at = (i: number): KnownCounts => counts.get(i) ?? { sampled: -1, known: -1 }
    check('all new: 1000 sampled, none known, 100% new, not flagged', at(0).sampled === 1000 && at(0).known === 0 && newSharePct(at(0)) === 100 && !isLowYield(at(0)), JSON.stringify(at(0)))
    check('all known: 1000 sampled, all known, 0% new, flagged LOW YIELD', at(1).sampled === 1000 && at(1).known === 1000 && newSharePct(at(1)) === 0 && isLowYield(at(1)), JSON.stringify(at(1)))
    check('half: 1000 sampled, 500 known, 50% new, not flagged', at(2).sampled === 1000 && at(2).known === 500 && newSharePct(at(2)) === 50 && !isLowYield(at(2)), JSON.stringify(at(2)))
    check('look-alike (www., capitals): all known by the normalised key', at(3).sampled === 400 && at(3).known === 400 && isLowYield(at(3)), JSON.stringify(at(3)))
    check('owned (rows held under the file\'s own, escaped name): none known, 100% new', at(4).sampled === 1000 && at(4).known === 0 && newSharePct(at(4)) === 100, JSON.stringify(at(4)))
    check('the scratch tables are gone', chQuery(`SELECT count() FROM system.tables WHERE name LIKE 'zz_known_%'`) === '0')

    console.log('4. The CLI')
    const cli = (args: string[], chContainer = CH) =>
      spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/preflight.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CH_CONTAINER: chContainer, INGEST_QUALITY_GATE_MIN_LINES: '100' } })
    const run = cli(['--known', paths.allNew, paths.allKnown, paths.half])
    check('--known exits 0 and prints the verdict and the expected share of each file', run.status === 0 && (run.stdout.match(/PASS/g) ?? []).length === 3 && (run.stdout.match(/expected new share/g) ?? []).length === 3, `${run.status} ${run.stdout}${run.stderr}`)
    check('--known prints ~100%, ~0% LOW YIELD and ~50% for the three files', /~100% \(sample 1000 rows, 0% of them already known\)/.test(run.stdout) && /~0% \(sample 1000 rows, 100% of them already known\)  LOW YIELD/.test(run.stdout) && /~50% \(sample 1000 rows, 50% of them already known\)/.test(run.stdout), run.stdout)
    const json = cli(['--known', '--json', paths.allKnown])
    check('--known --json carries the counts', JSON.parse(json.stdout.trim().split('\n')[0]).known?.known === 1000, json.stdout)
    const quiet = cli(['--known', '--quiet', paths.allKnown, paths.half])
    check('--known --quiet prints only the flagged file, on one line, without its name', quiet.stdout.trim().split('\n').length === 1 && /LOW YIELD/.test(quiet.stdout) && !quiet.stdout.includes('all-known'), quiet.stdout)
    const without = cli([paths.allKnown])
    check('without --known nothing about the share is printed and ClickHouse is not asked', !/expected new share/.test(without.stdout) && without.status === 0, without.stdout)

    console.log('5. A ClickHouse that does not answer')
    const dead = cli(['--known', paths.allNew], `ulprehearsal_nobody_${RUN}`)
    check('the verdict is still printed, the failure is reported and the exit code is 2', dead.status === 2 && /PASS/.test(dead.stdout) && /expected new share/.test(dead.stderr), `${dead.status} ${dead.stdout}${dead.stderr}`)
    let threw = false
    try { knownShareCounts(samples, { container: `ulprehearsal_nobody_${RUN}` }) } catch { threw = true }
    check('knownShareCounts throws for a container that does not exist', threw)
    return results.every(r => r.ok) ? 0 : 1
  } finally {
    rmSync(work, { recursive: true, force: true })
    try { chQuery(`DELETE FROM ulp.credentials WHERE source_file LIKE '%${RUN}%'`) } catch { /* the stack may be gone */ }
    if (weStarted && !keep) {
      try { compose(['down', '-v']) } catch (e) { console.error('teardown failed:', (e as Error).message) }
    }
    rmSync(dockerCfg, { recursive: true, force: true })
  }
}

main().then(code => {
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`)
  process.exit(code)
}, err => { console.error(err); process.exit(2) })
