/**
 * Proof of the reduced archive writer (docs/superpowers/plans/2026-11-15-reduced-archive.md) on a real ClickHouse: the ISOLATED rehearsal stack (docker-compose.rehearsal.yml; only
 * its ClickHouse is started, from the production init SQL, so `ulp.credentials` and `norm_key_hash` are the real ones). Every number below is known by construction.
 *
 * Five files are "imported" in order (the importer's parser and policy, then the commit statement: a row per key the table does not hold yet, the first by url and login):
 *   A  1000 new credentials, 100 in-file repeats, 30 banner lines, 20 blank lines, 10 tier-T3 lines
 *   B  500 credentials of A (known), 100 look-alikes of A's with `www.` and capitals (known on the normalised key), 400 new, 50 repeats, a new labelled block, a new
 *      url/login/password triple, a known block, 5 banner lines
 *   C  300 credentials of A and B, 20 blank lines: it adds nothing
 *   D  50 look-alikes of A's that D itself stored (the state before the normalised check): both A and D hold the key
 *   E  20 new credentials in a file whose name needs escaping in SQL
 *   I  1 Android credential (a login and password under an app id)
 *   H  the same Android line (known now), an unfinished labelled block with a repeat of that Android pair under another app id inside it (rule B of the parser drops the repeat),
 *      and 1 new credential
 *   L  2 new credentials around a line of more than 1 MiB (the parser cuts or reads whole such a line depending on how the bytes are chunked): left whole, not a failure
 *   M  a labelled block that closes into a credential of its own (new) and holds 20 credentials A stored and 10 new ones: the record covers the whole file, as one does in a dense file
 *   K  an unfinished labelled block (kept whole up to the blank line that closes it) holding 20 credentials A stored, 10 new ones among them, and repeats; then 1 new credential
 * and the reduced entry of each is written by reduceSource over the real ClickHouse and proven. Then: a row the database holds for B that no line of B produces makes B fail
 * is drift (reported, not a loss: today's parser never made it from the file); a writer that forgets a credential the file stored fails its proof and leaves nothing behind; A
 * reduced again after D stored look-alikes of its rows gives the same entry; H keeps the first Android line beside the copied repeat, or the repeat would read as a new
 * credential; K is compacted, the credentials it did not add inside the block are cut out and a placeholder line stands where each run of them was, and a placeholder the parser reads
 * as a credential makes the proof fail and the entry is written with the block whole (the proof is run twice on the real ClickHouse); every file cut into slabs of a few dozen rows gives the same entry and the same proof as in one slab; a container that does not exist is a clean failure; the command (scripts/reduce-archive.ts) runs
 * over the same ClickHouse; and no scratch table is left.
 *
 *   npx tsx scripts/e2e-reduced-archive.ts [--keep]
 *
 * It starts the rehearsal ClickHouse when it is not running and removes it afterwards unless --keep (or unless it was already running). Exit 0 when every check passes,
 * 1 when one fails, 2 when the rehearsal cannot start.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerCh } from '@/lib/clickhouse-cli'
import { chReduceDb, rowsToTsv, scratchDdl } from '@/lib/reduced-archive-ch'
import { readReduced, reduceSource, reducedDir, type LoadRow, type ReduceDb, type ReduceOutcome } from '@/lib/reduced-archive'
import { preflightHardDrop } from '@/lib/ingest-preflight'
import { appendManifest, archiveFile, archiveSource, sqlQuote, type ManifestEntry } from '@/lib/source-archive'
import { parseULPStream } from '@/lib/ulp-parser'

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

// ── the corpus ──────────────────────────────────────────────────────────────────────────────────────
const cred = (tag: string, i: number) => `https://shop${i % 50}.example.test/login:user-${tag}-${i}@mail.test:Pw-${tag}-${i}-Xy!`
const credWww = (tag: string, i: number) => `https://WWW.Shop${i % 50}.Example.test/login:USER-${tag}-${i}@MAIL.test:Pw-${tag}-${i}-Xy!`
const credT3 = (i: number) => `https://t3shop.example.test/login:t3-user-${i}@user.br:Pw-t3-${i}-Xy!`
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i)
const block = (tag: string, i: number) => [`Host: https://blk${i}.example.test/`, `Login: block-${tag}-${i}@mail.test`, `Password: BlockPw-${tag}-${i}!`, '']
const triple = (tag: string, i: number) => [`https://pos${i}.example.test/`, `triple-${tag}-${i}@mail.test`, `TriplePw-${tag}-${i}!`]
const banner = (tag: string, i: number) => `free text banner ${tag} ${i} that holds no credential`

const TAGS = { a: `${RUN}a`, b: `${RUN}b`, d: `${RUN}d`, e: `${RUN}e`, h: `${RUN}h`, k: `${RUN}k`, l: `${RUN}l`, m: `${RUN}m` }
const ANDROID_HASH = 'AbCdEfGhIjKlMnOpQrSt'
const androidFirst = `${ANDROID_HASH}==@com.example.app/:andr-${RUN}@mail.test:AndrPw-${RUN}!`
const androidRepeat = `${ANDROID_HASH}==@com.example.other/:andr-${RUN}@mail.test:AndrPw-${RUN}!`
const lines: Record<string, string[]> = {
  A: [...range(1000).map(i => cred(TAGS.a, i)), ...range(100).map(i => cred(TAGS.a, i)), ...range(30).map(i => banner('a', i)), ...range(20).map(() => ''), ...range(10).map(credT3)],
  B: [
    ...range(500).map(i => cred(TAGS.a, i)), ...range(100).map(i => credWww(TAGS.a, 500 + i)),
    ...range(400).map(i => cred(TAGS.b, i)), ...range(50).map(i => cred(TAGS.b, i)),
    ...block(TAGS.b, 1), ...triple(TAGS.b, 1), ...range(5).map(i => banner('b', i)),
  ],
  C: [...range(150).map(i => cred(TAGS.a, 200 + i)), ...range(150).map(i => cred(TAGS.b, i)), ...range(20).map(() => '')],
  D: range(50).map(i => credWww(TAGS.a, 800 + i)),
  E: range(20).map(i => cred(TAGS.e, i)),
  I: [androidFirst],
  H: [androidFirst, `Login: orphan-${RUN}@mail.test`, androidRepeat, '', cred(TAGS.h, 0)],
  L: [cred(TAGS.l, 0), 'y'.repeat((1 << 20) + 5000), cred(TAGS.l, 1)],
  M: [
    'Host: https://shopm.example.test/',
    ...range(10).flatMap(i => [cred(TAGS.a, 920 + 2 * i), cred(TAGS.a, 921 + 2 * i), cred(TAGS.m, i)]),
    `Login: blk-${RUN}m@mail.test`, `Password: BlockPw-${RUN}m!`, '',
  ],
  K: [
    `Login: orphan-${RUN}k@mail.test`,
    ...range(10).flatMap(i => [cred(TAGS.a, 900 + 2 * i), cred(TAGS.a, 901 + 2 * i), cred(TAGS.k, i)]),
    ...range(5).map(i => cred(TAGS.k, i)), '', cred(TAGS.k, 100),
  ],
}
// The known block of B: the credential of A's line 700, written as a labelled block (its key is A's).
lines.B.splice(lines.B.length - 5, 0, `Host: https://shop${700 % 50}.example.test/login`, `Login: user-${TAGS.a}-700@mail.test`, `Password: Pw-${TAGS.a}-700-Xy!`, '')
const NAMES: Record<string, string> = { A: `a-${RUN}.txt`, B: `b-${RUN}.txt`, C: `c-${RUN}.txt`, D: `d-${RUN}.txt`, E: `ow\\ned\tq'uote-${RUN}.txt`, I: `i-${RUN}.txt`, H: `h-${RUN}.txt`, K: `k-${RUN}.txt`, M: `m-${RUN}.txt`, L: `l-${RUN}.txt` }
const text = (key: string) => lines[key].join('\n') + '\n'

async function main(): Promise<number> {
  const dockerCfg = mkdtempSync(join(tmpdir(), 'rehearsal-docker-'))
  writeFileSync(join(dockerCfg, 'config.json'), '{}') // this laptop's global Docker config has a broken credsStore
  const env: NodeJS.ProcessEnv = {
    ...process.env, DOCKER_CONFIG: dockerCfg,
    REHEARSAL_JWT_SECRET: randomBytes(32).toString('hex'), REHEARSAL_ADMIN_EMAIL: 'admin@rehearsal.test',
    REHEARSAL_ADMIN_PASSWORD: randomBytes(18).toString('base64url') + 'Aa1!', REHEARSAL_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  }
  // The child processes of dockerCh inherit this process's environment.
  process.env.DOCKER_CONFIG = dockerCfg
  const compose = (args: string[]) => sh('docker', ['compose', '-f', COMPOSE_FILE, '-p', PROJECT, ...args], env)
  const state = () => sh('docker', ['ps', '-a', '--filter', `name=^${CH}$`, '--format', '{{.State}}'])
  const healthy = () => sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', CH]) === 'healthy'
  const ch = dockerCh(CH)
  const q = async (sql: string) => (await ch.run(sql)).trim()

  let weStarted = false
  const work = mkdtempSync(join(tmpdir(), 'reduced-e2e-'))
  const archive = join(work, 'archive')
  mkdirSync(archive)
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
    if (!(await waitFor('ClickHouse healthy', healthy, 240_000)) || !(await waitFor('ClickHouse answers', () => sh('docker', ['exec', CH, 'clickhouse-client', '--query', 'SELECT 1']) === '1', 120_000))) {
      console.error('The rehearsal ClickHouse did not come up.')
      return 2
    }
    check('ClickHouse started from the production init SQL, with norm_key_hash', (await q(`SELECT count() FROM system.columns WHERE database = 'ulp' AND table = 'credentials' AND name = 'norm_key_hash'`)) === '1')

    console.log('2. "Import" the files in order, and archive them whole')
    const hard = preflightHardDrop()
    const parseFile = async (body: string): Promise<LoadRow[]> => {
      const bytes = Buffer.from(body, 'latin1')
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close() } })
      const rows: LoadRow[] = []
      for await (const b of parseULPStream(stream, 'x', 100_000, hard, { dedupInFile: false })) for (const c of b.credentials) rows.push({ seq: rows.length, s: 0, e: 0, url: c.url, email: c.email, password: c.password })
      return rows
    }
    const importFile = async (name: string, body: string, stored?: LoadRow[]): Promise<number> => {
      const stage = `default.zz_e2e_stage_${RUN}`
      await ch.run(`DROP TABLE IF EXISTS ${stage} SYNC`)
      await ch.run(scratchDdl(stage))
      const rows = stored ?? await parseFile(body)
      await ch.insertTsv(`INSERT INTO ${stage} (seq, s, e, url, email, password) FORMAT TSV`, (async function* () { yield rowsToTsv(rows) })())
      // The commit statement of lib/ingest-novelty.ts on the normalised key: a row per key the table lacks, the first by (url, email).
      const insertWhere = stored
        ? `1`   // rows stored as they are, even though another file holds their key: the state before the normalised check
        : `k NOT IN (SELECT norm_key_hash FROM ulp.credentials WHERE norm_key_hash IN (SELECT k FROM ${stage}))`
      await ch.run(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) SELECT url, email, password, '', ${sqlQuote(name)}, '' FROM ${stage} WHERE ${insertWhere} ORDER BY url, email${stored ? '' : ' LIMIT 1 BY k'}`)
      await ch.run(`DROP TABLE IF EXISTS ${stage} SYNC`)
      return Number(await q(`SELECT count() FROM ulp.credentials WHERE source_file = ${sqlQuote(name)}`))
    }
    const entries: Record<string, ManifestEntry> = {}
    const stored: Record<string, number> = {}
    const importAndArchive = async (key: string): Promise<void> => {
      const plain = join(work, `${key}.txt`)
      writeFileSync(plain, text(key), 'latin1')
      stored[key] = key === 'D' ? await importFile(NAMES[key], text(key), await parseFile(text(key))) : await importFile(NAMES[key], text(key))
      entries[key] = archiveFile(plain, { archiveDir: archive, name: NAMES[key] })
      appendManifest(archive, entries[key])
    }
    for (const key of ['A', 'B', 'C', 'D', 'E']) await importAndArchive(key)
    check('the table holds what each import stored: A 1000, B 402, C 0, D 50, E 20', ['A', 'B', 'C', 'D', 'E'].map(k => stored[k]).join(',') === '1000,402,0,50,20', ['A', 'B', 'C', 'D', 'E'].map(k => stored[k]).join(','))
    for (const key of ['I', 'H', 'L', 'K', 'M']) await importAndArchive(key)
    check('the table holds I 1, H 1 (the Android line was known, its repeat is dropped by the parser), L 2, K 11 and M 11', stored.I === 1 && stored.H === 1 && stored.L === 2 && stored.K === 11 && stored.M === 11, `${stored.I},${stored.H},${stored.L},${stored.K},${stored.M}`)

    const reduce = async (key: string, chOverride = ch): Promise<ReduceOutcome> =>
      reduceSource({ entry: entries[key], archiveDir: archive, db: chReduceDb(chOverride), workDir: join(work, 'tmp') })
    const textOf = async (out: ReduceOutcome): Promise<string> => {
      if (!out.ok) return ''
      const chunks: Buffer[] = []
      for await (const c of archiveSource(reducedDir(archive), out.entry).stream()) chunks.push(Buffer.from(c))
      return Buffer.concat(chunks).toString('latin1')
    }
    const lineSet = (body: string) => new Set(body.split('\n').filter(l => l !== ''))

    console.log('3. A: everything new is kept once, banners are kept, repeats, blanks and T3 are not')
    const t0 = Date.now()
    const a = await reduce('A')
    console.log(`     (${Date.now() - t0} ms)`)
    check('A reduces and proves', a.ok, a.ok ? '' : `${a.reason}: ${a.detail}`)
    const aText = await textOf(a)
    // 1000 credentials, a blank line where the 100 repeats were, 30 banners
    check('A keeps its 1000 credentials and 30 banners, one blank line between them, and nothing else', aText.split('\n').length - 1 === 1031 && !aText.includes('user.br') && lineSet(aText).size === 1030, `${aText.split('\n').length - 1} lines`)
    if (a.ok) {
      check('A: counts', a.stats.parsed === 1100 && a.stats.distinct === 1000 && a.stats.mine === 1000 && a.stats.known === 0 && a.stats.absent === 0 && a.stats.repeats === 100, JSON.stringify(a.stats))
      check('A: proof counts', a.stats.proof?.dbRows === 1000 && a.stats.proof?.missing === 0 && a.stats.proof?.spurious === 0 && a.stats.proof?.notParsed === 0, JSON.stringify(a.stats.proof))
      check('A: the entry records what it was reduced from', a.entry.of.sha256 === entries.A.sha256 && a.entry.credentials === 1000 && a.entry.kept_lines === 1031)
    }

    console.log('4. B: known lines and look-alikes are dropped, the new block and triple are kept whole, the known block is dropped')
    const b = await reduce('B')
    check('B reduces and proves', b.ok, b.ok ? '' : `${b.reason}: ${b.detail}`)
    const bText = await textOf(b)
    // a blank line stands where lines were left out (the 50 repeats; the known block); the new block and the triple touch
    const expectB = [...range(400).map(i => cred(TAGS.b, i)), '', ...block(TAGS.b, 1), ...triple(TAGS.b, 1), '', ...range(5).map(i => banner('b', i))]
    check('B keeps exactly the 400 new credentials, the block with its separator, the triple and the banners, with a blank line at each gap', bText === expectB.join('\n') + '\n', `${bText.split('\n').length - 1} lines, expected ${expectB.length}`)
    if (b.ok) {
      check('B: counts', b.stats.parsed === 1053 && b.stats.distinct === 1003 && b.stats.mine === 402 && b.stats.known === 601 && b.stats.absent === 0 && b.stats.repeats === 50, JSON.stringify(b.stats))
      check('B: no known credential came along', b.entry.extra_known === 0 && b.stats.proof?.reducedKeys === 402, JSON.stringify(b.stats.proof))
    }

    console.log('5. C adds nothing: its reduced entry is empty')
    const c = await reduce('C')
    check('C reduces to an empty entry', c.ok && c.entry.size === 0 && c.entry.credentials === 0 && c.stats.known === 300, c.ok ? JSON.stringify(c.stats) : `${c.reason}: ${c.detail}`)

    console.log('6. D stored look-alikes of A\'s rows (two holders of one key): it keeps them, and A is unchanged')
    const d = await reduce('D')
    check('D keeps its 50 look-alikes', d.ok && d.entry.credentials === 50 && lineSet(await textOf(d)).size === 50 && d.stats.mine === 50 && d.stats.known === 0, d.ok ? JSON.stringify(d.stats) : `${d.reason}: ${d.detail}`)
    const a2 = await reduce('A')
    check('A reduced again, after D stored look-alikes of its rows, is the same entry', a2.ok && a.ok && a2.entry.sha256 === a.entry.sha256 && a2.entry.id === a.entry.id, a2.ok ? '' : `${a2.reason}: ${a2.detail}`)

    console.log('7. A file name that needs escaping')
    const e = await reduce('E')
    check('E (quote, backslash and tab in its name) reduces and keeps its 20 credentials', e.ok && e.entry.credentials === 20 && e.stats.proof?.dbRows === 20, e.ok ? '' : `${e.reason}: ${e.detail}`)

    console.log('7a. H: a repeat of an Android pair copied inside an unfinished block brings the first line of its pair along')
    const h = await reduce('H')
    check('H reduces and proves: no credential appears that the original does not make', h.ok && h.stats.proof?.spurious === 0 && h.stats.proof?.missing === 0, h.ok ? JSON.stringify(h.stats.proof) : `${h.reason}: ${h.detail}`)
    const hText = await textOf(h)
    check('H keeps the first Android line, the block with the repeat inside it, and the new credential', hText.includes(androidFirst) && hText.includes(androidRepeat) && hText.includes(cred(TAGS.h, 0)) && h.ok && h.entry.extra_known === 1, hText.split('\n').length - 1 + ' lines')

    console.log('7c. K: credentials the file did not add, inside a block kept whole, are cut out and a placeholder line stands where each run of them was')
    const k = await reduce('K')
    check('K reduces and proves, without falling back', k.ok && k.stats.proof?.missing === 0 && k.stats.proof?.spurious === 0 && k.stats.compactFallback === undefined, k.ok ? JSON.stringify(k.stats) : `${k.reason}: ${k.detail}`)
    const kText = await textOf(k)
    const expectK = [`Login: orphan-${RUN}k@mail.test`, ...range(10).flatMap(i => ['#', cred(TAGS.k, i)]), '#', '', cred(TAGS.k, 100)]
    check('K keeps the block line, its 10 new credentials and the one behind the blank line, with a placeholder for each run of known ones and repeats, and no known credential', kText === expectK.join('\n') + '\n', `${kText.split('\n').length - 1} lines, expected ${expectK.length}`)
    if (k.ok) {
      check('K: counts', k.stats.parsed === 36 && k.stats.mine === 11 && k.stats.known === 20 && k.stats.repeats === 5 && k.stats.placeholders === 11 && k.entry.placeholders === 11 && k.entry.extra_known === 0 && k.entry.kept_lines === 24, JSON.stringify(k.stats))
    }
    const kFall = await reduceSource({ entry: entries.K, archiveDir: archive, db: chReduceDb(ch), workDir: join(work, 'tmp'), placeholder: cred(TAGS.k, 999) })
    check('a placeholder that the parser reads as a credential fails the compacted proof; the entry is written with the block whole after a second proof on the same ClickHouse',
      kFall.ok && kFall.stats.compactFallback?.spurious === 1 && kFall.stats.compactFallback?.placeholders === 11 && kFall.entry.placeholders === 0 && kFall.stats.proof?.spurious === 0 && kFall.stats.proof?.missing === 0 && (await textOf(kFall)) === text('K'),
      kFall.ok ? JSON.stringify(kFall.stats) : `${kFall.reason}: ${kFall.detail}`)

    console.log('7c2. M: a record that covers the whole file keeps its own lines and loses the credentials nested in it that the file did not add')
    const mm = await reduce('M')
    check('M reduces and proves, without falling back', mm.ok && mm.stats.proof?.missing === 0 && mm.stats.proof?.spurious === 0 && mm.stats.compactFallback === undefined, mm.ok ? JSON.stringify(mm.stats) : `${mm.reason}: ${mm.detail}`)
    const mText = await textOf(mm)
    const expectM = ['Host: https://shopm.example.test/', ...range(10).flatMap(i => ['#', cred(TAGS.m, i)]), `Login: blk-${RUN}m@mail.test`, `Password: BlockPw-${RUN}m!`, '']
    check('M keeps the three lines of the record and its 10 new credentials, with a placeholder for each run of known ones', mText === expectM.join('\n') + '\n', `${mText.split('\n').length - 1} lines, expected ${expectM.length}`)
    if (mm.ok) {
      check('M: counts', mm.stats.parsed === 31 && mm.stats.mine === 11 && mm.stats.known === 20 && mm.stats.placeholders === 10 && mm.entry.extra_known === 0 && mm.entry.kept_lines === 24, JSON.stringify(mm.stats))
    }

    console.log('7d. L: a line over 1 MiB leaves the file whole')
    const nL = readReduced(archive).length
    const l = await reduce('L')
    check('L is left whole on purpose: reason long_line, no entry, no scratch table', !l.ok && l.reason === 'long_line' && readReduced(archive).length === nL, l.ok ? 'it was reduced' : `${l.reason}: ${l.detail}`)

    console.log('8. Drift, and a reduction that loses a credential')
    // A row the database holds for B that no line of B produces: an older parser stored it. Re-importing B would not make it either, so it is drift, not a loss.
    await ch.run(`INSERT INTO ulp.credentials (url, email, password, domain, source_file, breach_name) VALUES ('https://ghost.example.test/', 'ghost-${RUN}@mail.test', 'GhostPw-${RUN}!', '', ${sqlQuote(NAMES.B)}, '')`)
    const ghost = await reduce('B')
    check('B still reduces: the extra row is reported as drift, nothing is lost', ghost.ok && ghost.entry.db_drift === 1 && ghost.entry.db_keys === 403 && ghost.stats.proof?.missing === 0 && ghost.stats.proof?.notParsed === 1, ghost.ok ? JSON.stringify(ghost.stats.proof) : `${ghost.reason}: ${ghost.detail}`)
    // A writer that forgets the first credential it should keep.
    const n1 = readReduced(archive).length
    const lossy = await reduceSource({
      entry: entries.E, archiveDir: archive, workDir: join(work, 'tmp'),
      db: (real => ({ ...real, classify: async (name: string) => { const r = await real.classify(name); return { ...r, keep: r.keep.slice(2) } } }) as ReduceDb)(chReduceDb(ch)),
    })
    check('a reduction that would lose a credential the file stored fails its proof', !lossy.ok && lossy.reason === 'mismatch' && lossy.stats?.proof?.missing === 1, lossy.ok ? 'it passed' : `${lossy.reason}: ${lossy.detail}`)
    // C stored nothing: with ulp.sources saying its import stored rows, the rows are under another name and no entry would keep its lines
    const unrecorded = await reduceSource({ entry: entries.C, archiveDir: archive, workDir: join(work, 'tmp'), db: chReduceDb(ch), imported: 5 })
    check('rows recorded as imported but none held under the file name: no entry', !unrecorded.ok && unrecorded.reason === 'mismatch' && unrecorded.detail.includes('ulp.sources'), unrecorded.ok ? 'it passed' : unrecorded.detail)
    check('a failed proof writes no entry and no file', readReduced(archive).length === n1 && readdirSync(reducedDir(archive)).every(n => n === 'manifest.jsonl' || n.endsWith('.zst')) && readdirSync(join(work, 'tmp')).length === 0)
    const onDisk = readdirSync(reducedDir(archive)).filter(n => n.endsWith('.zst')).sort().join(',')
    const listed = [...new Set(readReduced(archive).map(x => `${x.id}.zst`))].sort().join(',')
    check('the reduced files on disk are exactly those of the manifest', onDisk === listed)

    console.log('9. A ClickHouse that is not there')
    const gone = await reduce('E', dockerCh('ulprehearsal_no_such_container'))
    check('a missing container is a clean failure that writes nothing', !gone.ok && gone.reason === 'error' && readReduced(archive).length === n1)

    console.log('10. Slabs: a file cut into many slabs gives the same entry and the same proof as one slab')
    const passes = { n: 0 }
    const counted: typeof ch = { run: sql => { if (sql.includes('norm_key_hash IN')) passes.n++; return ch.run(sql) }, insertTsv: (sql, rows) => ch.insertTsv(sql, rows), queryToFile: (sql, path) => ch.queryToFile(sql, path) }
    const slabCases: Array<[string, ReduceOutcome, number, number]> = [['A', a2, 97, 12], ['B', ghost, 97, 11], ['D', d, 7, 8], ['E', e, 7, 3], ['H', h, 1, 2], ['K', k, 13, 3], ['M', mm, 11, 3]]
    for (const [key, base, rows, expectPasses] of slabCases) {
      passes.n = 0
      const sl = await reduceSource({ entry: entries[key], archiveDir: archive, db: chReduceDb(counted, { slabRows: rows }), workDir: join(work, 'tmp') })
      check(`${key} in slabs of ${rows} rows (${expectPasses} passes over ulp.credentials) is the same entry and the same proof as in one slab`,
        sl.ok && base.ok && passes.n === expectPasses && sl.entry.id === base.entry.id && JSON.stringify(sl.stats) === JSON.stringify(base.stats),
        sl.ok ? `passes ${passes.n}, ${JSON.stringify(sl.stats)} vs ${base.ok ? JSON.stringify(base.stats) : base.detail}` : `${sl.reason}: ${sl.detail}`)
    }
    const n2 = readReduced(archive).length
    const lossySlabs = await reduceSource({
      entry: entries.E, archiveDir: archive, workDir: join(work, 'tmp'),
      db: (real => ({ ...real, classify: async (name: string) => { const r = await real.classify(name); return { ...r, keep: r.keep.slice(2) } } }) as ReduceDb)(chReduceDb(ch, { slabRows: 7 })),
    })
    check('a reduction that would lose a credential still fails its proof when the proof runs in slabs, and writes nothing', !lossySlabs.ok && lossySlabs.reason === 'mismatch' && lossySlabs.stats?.proof?.missing === 1 && readReduced(archive).length === n2)

    console.log('11. The command (scripts/reduce-archive.ts) over the same ClickHouse')
    // A second archive: A, B (with its drift row), C, F (archived, never imported) and G (imported, but its archive file is damaged).
    const archive2 = join(work, 'archive2')
    mkdirSync(archive2)
    const plainF = join(work, 'F.txt')
    const plainG = join(work, 'G.txt')
    writeFileSync(plainF, text('E').replace(RUN, `${RUN}f`), 'latin1')
    writeFileSync(plainG, text('E').replace(RUN, `${RUN}g`), 'latin1')
    const cmdNames: Record<string, string> = { A: NAMES.A, B: NAMES.B, C: NAMES.C, F: `f-${RUN}.txt`, G: `g-${RUN}.txt` }
    const shaOf: Record<string, string> = {}
    for (const key of ['A', 'B', 'C', 'F', 'G']) {
      const src = key === 'F' ? plainF : key === 'G' ? plainG : join(work, `${key}.txt`)
      const entry = archiveFile(src, { archiveDir: archive2, name: cmdNames[key] })
      appendManifest(archive2, entry)
      shaOf[key] = entry.sha256
      if (key === 'G') truncateSync(join(archive2, `${entry.id}.zst`), statSync(join(archive2, `${entry.id}.zst`)).size - 20)
    }
    for (const key of ['A', 'B', 'C', 'G']) await ch.run(`INSERT INTO ulp.sources (filename, line_count) VALUES (${sqlQuote(cmdNames[key])}, ${stored[key] ?? 0})`)
    const cli = (args: string[]) => {
      const r = spawnSync('npx', ['tsx', 'scripts/reduce-archive.ts', ...args], { encoding: 'utf8', env: { ...process.env, CH_CONTAINER: CH, ULP_ARCHIVE_DIR: archive2 }, maxBuffer: 1 << 24 })
      return { code: r.status, out: r.stdout + r.stderr }
    }
    let run3Out = ''
    const floorRun = cli(['run', '--pilot', '10', '--floor-gib', '999999'])
    check('under the free-space floor nothing starts', floorRun.code === 0 && floorRun.out.includes('not starting') && readReduced(archive2).length === 0, floorRun.out.slice(0, 200))
    const run1 = cli(['run', '--pilot', '10', '--floor-gib', '0'])
    check('run: A, B (drift) and C are reduced, G (damaged archive) fails, F (never imported) is not tried', run1.code === 1 && run1.out.includes('4 file(s) to reduce') && /reduced 3, failed 1/.test(run1.out) && readReduced(archive2).length === 3, run1.out.slice(-500))
    check('run says which file has drift', run1.out.includes('1 of 403 stored keys no longer read by the parser'), run1.out.slice(-500))
    const run2 = cli(['run', '--pilot', '10', '--floor-gib', '0'])
    check('a second run has nothing to do: done files are done, the failed one waits, F is not imported', run2.code === 0 && run2.out.includes('0 file(s) to reduce'), run2.out.slice(-300))
    const run3 = cli(['run', '--pilot', '10', '--floor-gib', '0', '--retry-failed'])
    run3Out = run3.out
    check('--retry-failed tries G again, and it fails again', run3.code === 1 && /reduced 0, failed 1/.test(run3.out), run3.out.slice(-300))
    const named = cli(['run', '--only-sha', shaOf.G.slice(0, 12), '--floor-gib', '0', '--retry-failed'])
    check('--only-sha names a file by its bytes (for a name that cannot be written on a command line), and a failed one is tried again with --retry-failed', named.code === 1 && named.out.includes('1 file(s) to reduce (named)') && /reduced 0, failed 1/.test(named.out), named.out.slice(-300))
    const redo = cli(['run', '--recompact-over', '0', '--floor-gib', '0'])
    check('--recompact-over finds nothing to do when every entry was written with the compaction', redo.code === 0 && redo.out.includes('0 file(s) to reduce (again, compacted: entries over 0%)'), redo.out.slice(-300))
    check('run never prints a credential or a line of a file', !/Pw-|BlockPw|TriplePw|GhostPw|@mail\.test|free text banner/.test(run1.out + run2.out + run3Out))
    const status = cli(['status'])
    check('status: 3 reduced of 5 names, the pilot tally by file, the failure by reason, the drift', status.out.includes('reduced entries 3 of 5') && status.out.includes('pilot: 3 exact, 1 failed of 4 tried') && status.out.includes('error 1') && status.out.includes('drift: 1 reduced file(s) hold 1 stored keys'), status.out.slice(0, 700))
    check('status: no file here carries placeholder lines (A, B and C hold no block to cut)', status.out.includes('compaction: 0 of 3 reduced file(s) carry placeholder lines (0 lines)'), status.out.slice(0, 900))
    const verify = cli(['verify', '--all'])
    check('verify: every reduced entry decodes and hashes', verify.code === 0 && verify.out.includes('verified 3, failed 0'), verify.out.slice(-200))

    console.log('12. Nothing left behind')
    check('no scratch table is left in ClickHouse', (await q(`SELECT count() FROM system.tables WHERE database = 'default' AND (name LIKE 'zz_red_%' OR name LIKE 'zz_e2e_stage_%')`)) === '0')
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(dockerCfg, { recursive: true, force: true })
    if (weStarted && !keep) {
      try { compose(['down', '-v']) } catch (err) { console.warn(`could not remove the rehearsal stack: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`)
  return failed.length === 0 ? 0 : 1
}

main().then(code => process.exit(code), err => { console.error(err instanceof Error ? err.message : err); process.exit(2) })
