import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * scripts/repair-scheme-split-rows.sh appends corrected copies of the scheme-split legacy rows (lib/legacy-repair.ts).
 * It is run here for real against a stand-in `docker` that answers from the environment and records every statement:
 * the stub shadows `docker` on PATH and DOCKER_HOST points at a dead socket, so no test can reach a real ClickHouse
 * (run() refuses to start unless `docker` resolves to the stub).
 */

const REPO = resolve(__dirname, '..')

// STUB_POLICY is read WITHOUT a colon-default: an explicitly empty value means "the app has no hard-drop tier configured".
const STUB_DOCKER = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  info|inspect) exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
if printf '%s ' "$@" | grep -q printenv; then printf '%s\\n' "\${STUB_POLICY-T3}"; exit 0; fi
sql=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--query" ]; then sql="$2"; break; fi
  shift
done
printf '%s\\n-- end of statement --\\n' "$sql" >> "$STUB_CALLS"
case "$sql" in
  *"FORMAT JSONEachRow"*)                     cat > "$STUB_STDIN" ;;
  *"SELECT url, email, password, source_file"*) cat "$STUB_ROWS" ;;
  *"AS candidate_rows"*)                      echo "\${STUB_CANDIDATES:-5}" ;;
  *"AS pending_mutations"*)                   echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)                            echo "\${STUB_FREE_GIB:-200}" ;;
  *"AS scratch_exists"*)                      echo "\${STUB_SCRATCH_EXISTS:-0}" ;;
  *"AS key_expression"*)                      echo "cityHash64(url, email, password)" ;;
  *"AS scratch_rows"*)                        printf '%b' "\${STUB_SCRATCH:-2\\\\t2\\\\n}" ;;
  *"AS already_present"*)                     echo "\${STUB_ALREADY:-0}" ;;
  *"AS keys_present"*)                        echo "\${STUB_PRESENT_AFTER:-2}" ;;
  *)                                          : ;;
esac
exit 0
`

// url, email, password, source_file, breach_name, imported_at (ClickHouse FORMAT TSV)
const ROWS = [
  'https\t//shop.example.com/login\talice@mail.com|hunter22\tcombo.txt\t\t2026-07-24 05:14:13',
  'https\t//a.example.org/x\tbob|ab\tcombo.txt\t\t2026-07-24 05:14:14',
  'https\t//site.example.ru/login\tx@mail.ru|secret1\tcombo.txt\tSomeBreach\t2026-08-02 10:00:00',
  'https\t//a.example.org/x\tcarol|p%40ssw0rd\tother.txt\t\t2026-08-03 11:12:13',
].join('\n') + '\n'

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'repair-scheme-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  const rowsPath = join(dir, 'rows.tsv')
  const stdinPath = join(dir, 'stdin.jsonl')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')
  writeFileSync(rowsPath, ROWS)
  writeFileSync(stdinPath, '')

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|KEEP$|STUB_|DOCKER_|CLICKHOUSE_|INGEST_FILTER_|MIN_FREE)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.STUB_ROWS = rowsPath
  base.STUB_STDIN = stdinPath

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'repair-scheme-split-rows.sh')], {
    cwd: REPO, env: { ...base, ...env }, encoding: 'utf8', timeout: 120_000,
  })
  return {
    status: r.status,
    out: (r.stdout ?? '') + (r.stderr ?? ''),
    calls: readFileSync(callsPath, 'utf8'),
    stdin: readFileSync(stdinPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
  }
}

const statements = (calls: string) => calls.split('-- end of statement --').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
const writes = (calls: string) => statements(calls).filter(s => /^(ALTER|KILL|INSERT|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|SYSTEM)\b/i.test(s))
const verb = (s: string) => s.replace(/\(.*/, '').replace(/ SELECT .*| SETTINGS .*| FORMAT .*/, '').trim()

describe('scripts/repair-scheme-split-rows.sh', () => {
  test('a dry run re-parses the candidates, reports counts, and writes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(r.out).toContain('repair-result: candidates=4 repaired=2 rejected=2')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('the candidate query uses the scheme-split predicate and nothing else', () => {
    const r = run({})
    const q = statements(r.calls).find(s => s.includes('SELECT url, email, password, source_file'))!
    expect(q).toContain("domain = '' AND url IN ('http','https') AND startsWith(email,'//')")
    expect(q).toContain('position(password,\'|\')>0')
  }, 120_000)

  test('APPLY=1: scratch table, scratch insert, ONE insert into the live table, scratch dropped; nothing else is written', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls).map(verb)).toEqual([
      'CREATE TABLE ulp.zz_scheme_split_repaired',
      'INSERT INTO ulp.zz_scheme_split_repaired',
      'INSERT INTO ulp.credentials',
      'DROP TABLE IF EXISTS ulp.zz_scheme_split_repaired SYNC',
    ])
    expect(r.out).toMatch(/appended/i)
  }, 120_000)

  test('the live insert copies the repaired columns with the ORIGINAL imported_at, skips keys already present, de-duplicates, and is synchronous', () => {
    const r = run({ APPLY: '1' })
    const live = statements(r.calls).find(s => s.startsWith('INSERT INTO ulp.credentials'))!
    expect(live).toContain('(url, email, password, domain, source_file, breach_name, imported_at)')
    expect(live).toContain('SELECT url, email, password, domain, source_file, breach_name, imported_at FROM ulp.zz_scheme_split_repaired')
    expect(live).toContain('content_key_hash NOT IN (SELECT content_key_hash FROM ulp.credentials WHERE content_key_hash IN (SELECT content_key_hash FROM ulp.zz_scheme_split_repaired))')
    expect(live).toContain('LIMIT 1 BY content_key_hash')
    expect(live).toContain('async_insert = 0')
    expect(live).not.toMatch(/now\(\)/i)
  }, 120_000)

  // A credential can be staged twice (two legacy rows that re-parse to the same line) and can sit in the live table more than
  // once (duplicates at rest are normal until the next content-dedup). Counting ROWS on either side made the live run of
  // 2026-10-01 report 998,267 appended when 1,009,474 had been appended, and would fail the final check on a table with duplicates.
  test('it counts DISTINCT credentials on both sides of the append, never rows', () => {
    const r = run({ APPLY: '1' })
    const already = statements(r.calls).find(s => s.includes('AS already_present'))!
    expect(already).toContain('SELECT uniqExact(content_key_hash) AS already_present')
    const present = statements(r.calls).find(s => s.includes('AS keys_present'))!
    expect(present).toContain('SELECT uniqExact(content_key_hash) AS keys_present')
  }, 120_000)

  test('what goes into the scratch table is exactly the repaired rows, as JSON, with the original timestamps', () => {
    const r = run({ APPLY: '1' })
    expect(r.stdin).toEqual([
      { url: 'https://shop.example.com/login', email: 'alice@mail.com', password: 'hunter22', domain: 'shop.example.com', source_file: 'combo.txt', breach_name: '', imported_at: '2026-07-24 05:14:13' },
      { url: 'https://a.example.org/x', email: 'carol', password: 'p@ssw0rd', domain: 'a.example.org', source_file: 'other.txt', breach_name: '', imported_at: '2026-08-03 11:12:13' },
    ])
  }, 120_000)

  test('the importer\'s hard-drop policy is read from the RUNNING app, so the T3 row is not re-introduced; with none configured it is', () => {
    const t3 = run({ APPLY: '1', STUB_POLICY: 'T3' })
    expect(t3.stdin.map(r => r.email)).not.toContain('x@mail.ru')
    const none = run({ APPLY: '1', STUB_POLICY: '' })
    expect(none.stdin.map(r => r.email)).toContain('x@mail.ru')
  }, 120_000)

  test('refuses (exit 2) while another mutation runs on the table', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '1' })
    expect(r.status).toBe(2)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('refuses (exit 2) with too little free disk', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '10' })
    expect(r.status).toBe(2)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('refuses (exit 2) when a scratch table from an earlier run is still there, and does not drop it', () => {
    const r = run({ APPLY: '1', STUB_SCRATCH_EXISTS: '1' })
    expect(r.status).toBe(2)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('nothing to repair: exit 0 and no writes', () => {
    const r = run({ APPLY: '1', STUB_CANDIDATES: '0' })
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/nothing to repair/i)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('exit 6, no insert into the live table, scratch dropped, when the scratch table does not hold what was repaired', () => {
    const r = run({ APPLY: '1', STUB_SCRATCH: '1\\t1\\n' })
    expect(r.status).toBe(6)
    expect(writes(r.calls).some(s => s.startsWith('INSERT INTO ulp.credentials'))).toBe(false)
    expect(writes(r.calls).map(verb)).toContain('DROP TABLE IF EXISTS ulp.zz_scheme_split_repaired SYNC')
  }, 120_000)

  test('exit 6 when, after the append, a repaired credential is still missing from the live table', () => {
    const r = run({ APPLY: '1', STUB_PRESENT_AFTER: '1' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/missing/i)
  }, 120_000)

  test('it never touches existing rows: no ALTER, DELETE, TRUNCATE or UPDATE anywhere', () => {
    const r = run({ APPLY: '1' })
    expect(r.calls).not.toMatch(/\bALTER\b|\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|\bOPTIMIZE\b|DROP TABLE ulp\.credentials/i)
  }, 120_000)
})
