import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { IMPORTED_DESC_PROJECTION_BODY } from '@/lib/credentials-projections'

/**
 * scripts/rebuild-imported-desc-projection.sh re-creates proj_imported_desc with is_noise and content_key_hash (DDL v27) on the
 * live table and builds it for every partition in scope: ~495M rows, ~34 GiB written. It is run here for real against a
 * stand-in `docker` that answers from the environment and records every statement: the stub shadows `docker` on PATH and
 * DOCKER_HOST points at a dead socket, so no test can reach a real ClickHouse (run() refuses to start unless `docker` is the stub).
 */

const REPO = resolve(__dirname, '..')

// STUB_PARTITIONS / STUB_MISSING are read WITHOUT a colon-default: an explicitly empty value means "none".
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
# the stand-in ClickHouse remembers that the new definition was added, so the verification can see it
case "$sql" in *"ADD PROJECTION IF NOT EXISTS"*) : > "$STUB_CALLS.added" ;; esac
case "$sql" in
  *"AS projection_current"*)       if [ -e "$STUB_CALLS.added" ]; then echo 1; else echo "\${STUB_CURRENT:-0}"; fi ;;
  *"AS pending_mutations"*)        echo "\${STUB_PENDING:-0}" ;;
  *"AS free_gib"*)                 echo "\${STUB_FREE_GIB:-200}" ;;
  *"AS scope_partition"*)          printf '%b' "\${STUB_PARTITIONS-202608\\n}" ;;
  *"AS partition_missing_projection"*) printf '%b' "\${STUB_MISSING-202608\\n}" ;;
  *"AS parts_without_projection"*) echo "\${STUB_UNPROJECTED:-0}" ;;
  *"AS newest_ts"*)                echo "1787960054" ;;
  *"AS projection_check"*)         echo "\${STUB_PROJECTION_CHECK:-1}" ;;
  *"AS mutation_state"*)           printf '%b' "\${STUB_MUTATION_STATE:-1\\t0\\t\\n}" ;;
  *"AS last_mutation"*)            echo "\${STUB_LAST_MUTATION-}" ;;
  *)                               : ;;
esac
exit 0
`

function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-proj-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')

  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPLY$|STUB_|DOCKER_|CLICKHOUSE_|MIN_FREE|ABORT_FREE|POLL_|MAX_)/.test(k)) base[k] = v
  }
  base.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  base.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  base.STUB_CALLS = callsPath
  base.POLL_SECONDS = '0'

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env: base, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)

  const r = spawnSync('bash', [join(REPO, 'scripts', 'rebuild-imported-desc-projection.sh')], {
    cwd: REPO, env: { ...base, ...env }, encoding: 'utf8', timeout: 120_000,
  })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), calls: readFileSync(callsPath, 'utf8') }
}

const statements = (calls: string) => calls.split('-- end of statement --').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
const writes = (calls: string) => statements(calls).filter(s => /^(ALTER|KILL|INSERT|DROP|CREATE|DELETE|TRUNCATE|OPTIMIZE|SYSTEM)\b/i.test(s))
const alters = (calls: string) => writes(calls).filter(s => s.startsWith('ALTER')).map(s => s.replace(/ SETTINGS .*/, ''))

describe('scripts/rebuild-imported-desc-projection.sh', () => {
  test('a dry run reports the plan and changes nothing', () => {
    const r = run({})
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/dry run/i)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('APPLY=1 on the old projection: drop it, add the shared body, materialize each partition in scope; nothing else is written', () => {
    const r = run({ APPLY: '1', STUB_PARTITIONS: '202608\\n202607\\n', STUB_MISSING: '202608\\n202607\\n' })
    expect(r.status).toBe(0)
    expect(alters(r.calls)).toEqual([
      'ALTER TABLE ulp.credentials DROP PROJECTION IF EXISTS proj_imported_desc',
      expect.stringContaining('ALTER TABLE ulp.credentials ADD PROJECTION IF NOT EXISTS proj_imported_desc ('),
      "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202608'",
      "ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202607'",
    ])
    const add = statements(r.calls).find(s => s.includes('ADD PROJECTION IF NOT EXISTS'))!
    expect(add.replace(/\s+/g, '')).toContain(IMPORTED_DESC_PROJECTION_BODY.replace(/\s+/g, ''))
    expect(r.calls).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bOPTIMIZE\b|DROP TABLE|ALTER TABLE ulp\.credentials\s+(UPDATE|MODIFY|DROP COLUMN)/i)
    expect(r.out).toMatch(/proj_imported_desc is ready/i)
  }, 120_000)

  test('every materialize is submitted asynchronously and polled (a synchronous ALTER sits silent past the client\'s 300 s receive timeout)', () => {
    const r = run({ APPLY: '1' })
    expect(r.status).toBe(0)
    const materialize = statements(r.calls).find(s => s.startsWith('ALTER TABLE ulp.credentials MATERIALIZE PROJECTION'))!
    expect(materialize).toContain('mutations_sync = 0')
    expect(statements(r.calls).filter(s => s.includes('AS mutation_state') && s.includes('MATERIALIZE PROJECTION proj_imported_desc IN PARTITION')).length).toBeGreaterThan(0)
  }, 120_000)

  test('it only waits for a mutation NEWER than the newest one that existed before it submitted its own', () => {
    const r = run({ APPLY: '1', STUB_LAST_MUTATION: '0000000012' })
    expect(r.status).toBe(0)
    expect(r.calls).toContain("mutation_id > '0000000012'")
  }, 120_000)

  test('already current and nothing missing: no drop, no add, no materialize', () => {
    const r = run({ APPLY: '1', STUB_CURRENT: '1', STUB_MISSING: '' })
    expect(r.status).toBe(0)
    expect(alters(r.calls)).toEqual([])
    expect(r.out).toMatch(/proj_imported_desc is ready/i)
  }, 120_000)

  test('already current but a partition has parts without it (a restore half done): materialize just that partition, drop nothing', () => {
    const r = run({ APPLY: '1', STUB_CURRENT: '1', STUB_MISSING: '202608\\n' })
    expect(r.status).toBe(0)
    expect(alters(r.calls)).toEqual(["ALTER TABLE ulp.credentials MATERIALIZE PROJECTION proj_imported_desc IN PARTITION '202608'"])
  }, 120_000)

  test('refuses (exit 2), changing nothing, while another mutation runs', () => {
    const r = run({ APPLY: '1', STUB_PENDING: '2' })
    expect(r.status).toBe(2)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('refuses (exit 2), BEFORE dropping anything, with too little free disk', () => {
    const r = run({ APPLY: '1', STUB_FREE_GIB: '20' })
    expect(r.status).toBe(2)
    expect(writes(r.calls)).toEqual([])
  }, 120_000)

  test('exit 6 when, after the build, a part in scope still lacks the projection', () => {
    const r = run({ APPLY: '1', STUB_UNPROJECTED: '1' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/without proj_imported_desc/i)
  }, 120_000)

  test('exit 6 when a windowed query does not use the projection or reads the whole partition', () => {
    const r = run({ APPLY: '1', STUB_PROJECTION_CHECK: '0' })
    expect(r.status).toBe(6)
    expect(r.out).toMatch(/windowed query/i)
  }, 120_000)

  test('the functional check runs the windowed form on the projection key, with its own query id, and reads system.query_log', () => {
    const r = run({ APPLY: '1' })
    const probe = statements(r.calls).find(s => s.includes('negate(toUnixTimestamp(imported_at)) <'))!
    expect(probe).toBeDefined()
    expect(probe).toContain('is_noise = 0')
    expect(statements(r.calls).some(s => /FROM system\.query_log/.test(s) && s.includes('proj_imported_desc') && s.includes('read_rows'))).toBe(true)
  }, 120_000)

  test('the partitions to build come from the shared scope SQL, which always includes the newest partition', () => {
    const r = run({})
    const scope = statements(r.calls).find(s => s.includes('AS scope_partition'))!
    expect(scope).toMatch(/OR partition = \(SELECT max\(partition\)/)
  }, 120_000)
})
