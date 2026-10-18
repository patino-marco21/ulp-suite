import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * scripts/materialize-address-index.sh adds the lower(email) bloom filter to the existing parts after DDL v29. It is a mutation on a
 * 1.84B-row table, so it is run here for real against a stand-in `docker` that answers from the environment and records every statement:
 * the stub shadows `docker` on PATH and DOCKER_HOST points at a dead socket, so no test can reach a real ClickHouse (run() refuses to
 * start unless `docker` resolves to the stub).
 */

const REPO = resolve(__dirname, '..')

const DEFAULT_EXPLAIN = [
  'ReadFromMergeTree (ulp.credentials)',
  'Indexes:',
  '  PrimaryKey',
  '    Condition: true',
  '    Parts: 18/18',
  '    Granules: 225000/225000',
  '  Skip',
  '    Name: idx_bf_email_lc',
  '    Description: bloom_filter GRANULARITY 1',
  '    Parts: 18/18',
  '    Granules: 11000/225000',
].join('\n')

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
  *"AS pending_mutations"*)  echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)           echo "\${STUB_FREE_GIB:-200}" ;;
  *"AS index_defined"*)      echo "\${STUB_DEFINED:-0}" ;;
  *"AS index_expression"*)   echo "\${STUB_INDEX_EXPR:-lower(email)}" ;;
  *"AS partition_id"*)       printf '%b' "\${STUB_PARTITIONS-202608\\\\n202607\\\\n}" ;;
  *"AS mutation_state"*)     printf '%b' "\${STUB_MUTATION_STATE:-1\\\\t0\\\\t\\\\n}" ;;
  *"AS last_mutation"*)      echo "\${STUB_LAST_MUTATION-}" ;;
  *"EXPLAIN indexes"*)       printf '%s\\n' "$STUB_EXPLAIN" ;;
  *"AS index_size"*)         echo "1.20 GiB" ;;
  *)                         : ;;
esac
exit 0
`

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'address-index-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|STUB_|DOCKER_|CLICKHOUSE_|MIN_FREE|ABORT_|POLL_|MAX_)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.STUB_EXPLAIN = DEFAULT_EXPLAIN
  base.POLL_SECONDS = '0'

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base as NodeJS.ProcessEnv, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'materialize-address-index.sh')], {
    cwd: REPO,
    env: { ...base, ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: readFileSync(callsPath, 'utf8') }
}

/** Every statement the script sent that is not a read, whitespace collapsed, SETTINGS dropped. */
const writes = (calls: string) =>
  calls.split('-- end of statement --').map(s => s.trim()).filter(s => /^(ALTER|KILL|INSERT|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|SYSTEM)\b/i.test(s))
    .map(s => s.replace(/\s+/g, ' ').replace(/ SETTINGS .*/, ''))

const ADD = 'ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_email_lc lower(email) TYPE bloom_filter(0.05) GRANULARITY 1'

describe('scripts/materialize-address-index.sh', () => {
  test('a dry run checks the preconditions, says what it would do, and changes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(r.out).toContain('not defined yet')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('APPLY=1 adds the definition, materializes one partition at a time (smallest first) and verifies; nothing else is written', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([
      ADD,
      "ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_email_lc IN PARTITION '202608'",
      "ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_email_lc IN PARTITION '202607'",
    ])
    // The check runs with projections off, like the app's lookups (a projection read never uses the index).
    expect(r.calls).toMatch(/EXPLAIN indexes = 1 SELECT count\(\).*optimize_use_projections = 0/s)
    expect(r.out).toContain('11000 of 225000')
    expect(r.calls).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|KILL MUTATION/i)
  }, 120_000)

  test('an index that is already defined is not added again', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls).every(s => !s.includes('ADD INDEX'))).toBe(true)
    expect(writes(r.calls)).toHaveLength(2)
  }, 120_000)

  test('it refuses while another mutation is running', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '2' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/mutation/i)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses under MIN_FREE_GIB (130 by default)', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '100' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('only 100 GiB free')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses when an index of that name indexes something else', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_INDEX_EXPR: 'email' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('idx_bf_email_lc')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('free disk falling under ABORT_FREE_GIB while a mutation runs kills it and stops', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', MIN_FREE_GIB: '10', ABORT_FREE_GIB: '150', STUB_FREE_GIB: '120', STUB_MUTATION_STATE: '0\\t3\\t\\n' })
    expect(r.status).toBe(4)
    expect(r.calls).toMatch(/KILL MUTATION WHERE database = 'ulp' AND table = 'credentials'/)
    expect(r.out).toMatch(/killed/i)
  }, 120_000)

  test('a mutation that keeps failing is reported and the script stops', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_MUTATION_STATE: '0\\t3\\tCode: 999. boom\\n' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('boom')
  }, 120_000)

  test('an index that still selects most granules is rejected (a part without it)', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_EXPLAIN: DEFAULT_EXPLAIN.replace('11000/225000', '200000/225000') })
    expect(r.status).toBe(6)
    expect(r.out).toContain('200000 of 225000')
  }, 120_000)

  test('an EXPLAIN that never mentions the index is rejected (the expression did not match)', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1', STUB_EXPLAIN: 'ReadFromMergeTree (ulp.credentials)\nIndexes:\n  PrimaryKey\n    Granules: 225000/225000' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/not used/i)
  }, 120_000)

  test('the verification runs after the last MATERIALIZE', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '1' })
    expect(r.calls.lastIndexOf('MATERIALIZE INDEX')).toBeLessThan(r.calls.indexOf('EXPLAIN indexes'))
  }, 120_000)
})
