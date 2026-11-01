import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { NORM_CONTENT_KEY } from '@/lib/url-content-key'

/**
 * scripts/materialize-norm-key.sh fills norm_key_hash in the existing parts after DDL v30. It is a mutation on a 2.6B-row table, so it is run here for
 * real against a stand-in `docker` that answers from the environment and records every statement: the stub shadows `docker` on PATH and DOCKER_HOST
 * points at a dead socket, so no test can reach a real ClickHouse (run() refuses to start unless `docker` resolves to the stub).
 */

const REPO = resolve(__dirname, '..')

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
  *"AS column_defined"*)      echo "\${STUB_DEFINED:-1}" ;;
  *"AS pending_mutations"*)   echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)            echo "\${STUB_FREE_GIB:-200}" ;;
  *"AS partition_id"*)        printf '%b' "\${STUB_PARTITIONS-202611\\\\n202610\\\\n}" ;;
  *"AS partition_complete"*)
    out=0
    for id in \${STUB_COMPLETE:-}; do
      case "$sql" in *"partition = '$id'"*) out=1 ;; esac
    done
    echo "$out" ;;
  *"AS parts_total"*)         echo "\${STUB_PARTS_TOTAL:-16}" ;;
  *"AS parts_with_column"*)   echo "\${STUB_PARTS_WITH:-16}" ;;
  *"AS mutation_state"*)      printf '%b' "\${STUB_MUTATION_STATE:-1\\\\t0\\\\t\\\\n}" ;;
  *"AS last_mutation"*)       echo "\${STUB_LAST_MUTATION-}" ;;
  *"AS norm_mismatches"*)     echo "\${STUB_MISMATCHES:-0}" ;;
  *"AS sample_rows"*)         printf '%b' "\${STUB_SAMPLE-40000000\\\\t36800000\\\\n}" ;;
  *)                          : ;;
esac
exit 0
`

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'norm-key-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|ONLY_|STUB_|DOCKER_|CLICKHOUSE_|MIN_FREE|ABORT_|POLL_|MAX_)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.POLL_SECONDS = '0'

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base as NodeJS.ProcessEnv, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'materialize-norm-key.sh')], {
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

const MATERIALIZE = (p: string) => `ALTER TABLE ulp.credentials MATERIALIZE COLUMN norm_key_hash IN PARTITION '${p}'`

describe('scripts/materialize-norm-key.sh', () => {
  test('a dry run checks the preconditions, says what it would do, and changes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(r.out).toContain('column: defined')
    expect(r.out).toContain('partitions (smallest first): 202611 202610')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('APPLY=1 materializes one partition at a time (smallest first), verifies, and prints the exact share of surplus rows; nothing else is written', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([MATERIALIZE('202611'), MATERIALIZE('202610')])
    expect(r.out).toContain('every one of 16 parts holds norm_key_hash')
    expect(r.out).toContain('3200000 of 40000000 in a 1/64 bucket = 8.00%')
    expect(r.calls).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|KILL MUTATION/i)
  }, 120_000)

  test('it checks the stored value against the expression the code defines, not a copy of it', () => {
    const r = run({ APPLY: '1' })
    expect(r.calls).toContain(`norm_key_hash != ${NORM_CONTENT_KEY}`)
  }, 120_000)

  test('a partition whose parts all hold the column already is not recomputed', () => {
    const r = run({ APPLY: '1', STUB_COMPLETE: '202611' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([MATERIALIZE('202610')])
    expect(r.out).toContain('partition 202611: every part already holds norm_key_hash, skipped')
  }, 120_000)

  test('ONLY_PARTITION does one partition, reports its time and the free disk, and skips the final checks', () => {
    const r = run({ APPLY: '1', ONLY_PARTITION: '202611' })
    expect(r.status).toBe(0)
    expect(writes(r.calls)).toEqual([MATERIALIZE('202611')])
    expect(r.out).toMatch(/partition 202611 done in \d+ s; free disk \d+ GiB/)
    expect(r.out).toMatch(/final checks skipped/i)
    expect(r.calls).not.toContain('AS norm_mismatches')
  }, 120_000)

  test('ONLY_PARTITION names a partition the table has, or nothing is done', () => {
    const r = run({ APPLY: '1', ONLY_PARTITION: '299999' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('299999')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses when the column is not defined (the image with DDL v30 has not started yet)', () => {
    const r = run({ APPLY: '1', STUB_DEFINED: '0' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/no norm_key_hash column/)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses while another mutation is running', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '2' })
    expect(r.status).toBe(2)
    expect(r.out).toMatch(/mutation/i)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('it refuses under MIN_FREE_GIB (170 by default)', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '100' })
    expect(r.status).toBe(2)
    expect(r.out).toContain('only 100 GiB free')
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('free disk falling under ABORT_FREE_GIB while a mutation runs kills it and stops', () => {
    const r = run({ APPLY: '1', MIN_FREE_GIB: '10', ABORT_FREE_GIB: '150', STUB_FREE_GIB: '120', STUB_MUTATION_STATE: '0\\t3\\t\\n' })
    expect(r.status).toBe(4)
    expect(r.calls).toMatch(/KILL MUTATION WHERE database = 'ulp' AND table = 'credentials'/)
    expect(r.out).toMatch(/killed/i)
  }, 120_000)

  test('a mutation that keeps failing is reported and the script stops', () => {
    const r = run({ APPLY: '1', STUB_MUTATION_STATE: '0\\t3\\tCode: 999. boom\\n' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('boom')
  }, 120_000)

  test('parts that still lack the column after the last mutation are reported: the importer keeps the exact key', () => {
    const r = run({ APPLY: '1', STUB_PARTS_WITH: '15' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('only 15 of 16 parts hold norm_key_hash')
  }, 120_000)

  test('a stored value that differs from the expression on the sample is rejected', () => {
    const r = run({ APPLY: '1', STUB_MISMATCHES: '3' })
    expect(r.status).toBe(6)
    expect(r.out).toContain('3 rows of a 1/64 sample')
  }, 120_000)

  test('the checks run after the last MATERIALIZE', () => {
    const r = run({ APPLY: '1' })
    expect(r.calls.lastIndexOf('MATERIALIZE COLUMN')).toBeLessThan(r.calls.indexOf('AS norm_mismatches'))
  }, 120_000)
})
