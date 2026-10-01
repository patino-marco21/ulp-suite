import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * scripts/materialize-country-tier.sh backfills ulp.credentials.country_tier after DDL v26. It is a mutation over
 * 1.39B rows (and rebuilds proj_imported_desc), so it is run here for real against a stand-in `docker` that answers
 * from the environment and records every statement it is asked to run: the stub shadows `docker` on PATH and
 * DOCKER_HOST points at a dead socket, so no test can reach a real ClickHouse (run() refuses to start unless
 * `docker` resolves to the stub).
 */

const REPO = resolve(__dirname, '..')

// STUB_PROJ_PARTS is read WITHOUT a colon-default below: an explicitly empty value means "no partition has the projection".
const STUB_DOCKER = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  info|inspect) exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
sql=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--query" ]; then sql="$2"; break; fi
  shift
done
printf '%s\\n-- end of statement --\\n' "$sql" >> "$STUB_CALLS"
case "$sql" in
  *"AS live_expression"*)        printf '%s\\n' "$STUB_EXPR" ;;
  *"AS pending_mutations"*)      echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)               echo "\${STUB_FREE_GIB:-200}" ;;
  *"cityHash64(email, url) %"*)  cat "$STUB_PARITY" ;;
  *"AS mutation_state"*)         printf '%b' "\${STUB_MUTATION_STATE:-1\\t0\\t\\n}" ;;
  *"MATERIALIZE COLUMN"*)        : ;;
  *"AS stored_ne_expression"*)   echo "\${STUB_FULL_MISMATCH:-0}" ;;
  *"AS projection_partition"*)   printf '%b' "\${STUB_PROJ_PARTS-202608\\n}" ;;
  *"AS stale_in_projection"*)    echo "\${STUB_PROJ_STALE:-0}" ;;
  *"GROUP BY country_tier"*)     printf 'T3\\t100\\n\\t999\\n' ;;
  *)                             : ;;
esac
exit 0
`

const NEW_EXPR = "multiIf(endsWith(email_domain,'.co.uk'), 'T1', '')"
const OLD_EXPR = "multiIf(endsWith(splitByChar('@', lower(email))[-1], '.co.uk'), 'T1', '')"
// stored <TAB> expected <TAB> email <TAB> url: every row agrees with the importer
const PARITY_OK = ['\t\tbob@gmail.com\thttps://x.com', 'T3\tT3\ta@mail.ru\thttps://x.com', 'T1\tT1\tc@gmail.com\thttps://shop.example.co.uk/'].join('\n') + '\n'
// the expression says T3 for a row the importer calls untiered
const PARITY_BAD = ['T3\tT3\tbob@gmail.com\thttps://x.com'].join('\n') + '\n'

function run(env: Record<string, string>, parity = PARITY_OK) {
  const dir = mkdtempSync(join(tmpdir(), 'tier-backfill-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  const parityPath = join(dir, 'parity.tsv')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')
  writeFileSync(parityPath, parity)

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|STUB_|DOCKER_|CLICKHOUSE_|MIN_FREE|POLL_|MAX_)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.STUB_PARITY = parityPath
  base.STUB_EXPR = NEW_EXPR
  base.POLL_SECONDS = '0'

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'materialize-country-tier.sh')], {
    cwd: REPO,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: readFileSync(callsPath, 'utf8') }
}

// The ALTER statement itself (the progress query mentions the same words in a LIKE).
const materializes = (calls: string) => (calls.match(/ALTER TABLE ulp\.credentials MATERIALIZE COLUMN country_tier/g) ?? []).length
/** Every statement the script sent that is not a read: the first word of each recorded statement, uppercased. */
const writes = (calls: string) =>
  calls.split('-- end of statement --').map(s => s.trim()).filter(s => /^(ALTER|KILL|INSERT|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|SYSTEM)\b/i.test(s)).map(s => s.replace(/\s+/g, ' ').replace(/ SETTINGS .*/, ''))
const destructive = (calls: string) => /\bDROP\b|\bDELETE\b|\bTRUNCATE\b|KILL MUTATION|ALTER TABLE ulp\.credentials\s+(UPDATE|MODIFY|ADD|DROP)/i.test(calls)

describe('scripts/materialize-country-tier.sh', () => {
  test('a dry run checks everything, reports, and changes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(r.out).toContain('parity-result: checked=3')
    expect(materializes(r.calls)).toBe(0)
  }, 120_000)

  test('APPLY=1 backfills the column, rebuilds the projection that carries it, and verifies both; nothing else is written', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    expect(materializes(r.calls)).toBe(1)
    // MATERIALIZE COLUMN rewrites the base column only: proj_imported_desc keeps the OLD labels (measured on a scratch copy:
    // 0 stale in the base column, 92,635 of 24.76M in the projection) until it is cleared and materialized again.
    expect(writes(r.calls)).toEqual([
      'ALTER TABLE ulp.credentials MATERIALIZE COLUMN country_tier',
      "ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '202608'",
      "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202608'",
    ])
    expect(r.calls).toContain('AS stored_ne_expression')
    expect(r.calls).toContain('AS stale_in_projection')
    // the whole-table check reads base columns, so it must not be answered from the (possibly stale) projection
    expect(r.calls).toMatch(/AS stored_ne_expression[\s\S]*optimize_use_projections = 0/)
    expect(destructive(r.calls)).toBe(false)
    expect(r.out).toMatch(/country_tier is now consistent/i)
  }, 120_000)

  test('every partition that carries the projection is rebuilt, and only those', () => {
    const r = run({ APPLY: '1', STUB_PROJ_PARTS: '202607\\n202608\\n' })
    expect(r.status).toBe(0)
    expect(writes(r.calls).filter(w => /PROJECTION/.test(w))).toEqual([
      "ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '202607'",
      "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202607'",
      "ALTER TABLE ulp.credentials CLEAR PROJECTION proj_imported_desc IN PARTITION '202608'",
      "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202608'",
    ])
  }, 120_000)

  test('no partition carries the projection: nothing to rebuild', () => {
    const r = run({ APPLY: '1', STUB_PROJ_PARTS: '' })
    expect(r.status).toBe(0)
    expect(writes(r.calls).filter(w => /PROJECTION/.test(w))).toEqual([])
  }, 120_000)

  test('exit 6 when the projection still serves a stale label after the rebuild', () => {
    const r = run({ APPLY: '1', STUB_PROJ_STALE: '7' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/proj_imported_desc/)
    expect(r.out).toMatch(/7 rows/)
  }, 120_000)

  test('refuses (exit 2) while the column still has the old expression: deploy DDL v26 first', () => {
    const r = run({ APPLY: '1', STUB_EXPR: OLD_EXPR })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/v26/)
    expect(materializes(r.calls)).toBe(0)
  }, 120_000)

  test('refuses (exit 2) while another mutation is running on the table', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '2' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/mutation/i)
    expect(materializes(r.calls)).toBe(0)
  }, 120_000)

  test('refuses (exit 2) with less free disk than the projection rebuild needs', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '50' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/free/i)
    expect(materializes(r.calls)).toBe(0)
  }, 120_000)

  test('refuses (exit 3) when the new expression disagrees with the importer on the sample', () => {
    const r = run({ APPLY: '1' }, PARITY_BAD)
    expect(r.status).toBe(3)
    expect(r.out).toMatch(/refusing/i)
    expect(materializes(r.calls)).toBe(0)
  }, 120_000)

  test('exit 6 when the mutation fails', () => {
    const r = run({ APPLY: '1', STUB_MUTATION_STATE: '0\\t3\\tCode: 241. DB::Exception: memory limit\\n' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/Code: 241/)
  }, 120_000)

  test('exit 6 when the whole-table check still finds a stored label that differs from the expression', () => {
    const r = run({ APPLY: '1', STUB_FULL_MISMATCH: '5' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/5 rows/)
  }, 120_000)
})
