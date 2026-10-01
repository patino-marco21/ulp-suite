import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * The two destructive tier purges must never delete a row the ingest classifier
 * (lib/ingest-filter.ts) would not itself have dropped. They are run here for real,
 * with a stand-in `docker` that records every statement it is asked to run:
 *
 *   - the stub shadows `docker` on PATH and DOCKER_HOST points at a dead socket, so no
 *     test can ever reach a real ClickHouse (run() refuses to start unless `docker`
 *     resolves to the stub);
 *   - the statements it records are what each script submitted.
 *
 * Background: on 2026-10-01 1,919,919 rows of ulp.credentials carried country_tier = 'T3'
 * and the importer's own classifyTier() called none of them T3 (logins with no '@').
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
  *"SELECT email, url"*)      cat "$STUB_AUDIT" ;;
  *"AS candidate_rows"*)      wc -l < "$STUB_AUDIT" | tr -d ' ' ;;
  *"SELECT mutation_id"*)     : ;;
  *"FROM system.mutations"*)  echo 0 ;;
  *"AS remaining_t3"*)        echo 0 ;;
  *"formatReadableSize"*)     echo "1.00 GiB" ;;
  *)                          : ;;
esac
exit 0
`

// Rows as ClickHouse prints them: email <TAB> url.
const MISLABELED = [
  'john.vn\thttps://accounts.google.com', // no "@": the importer says untiered
  'maria.br\thttps://login.microsoftonline.com', // no "@"
  'a@att.com\thttps://shop.com.br/login', // email verdict T1 beats the .br URL
]
const REAL_T3 = [
  'a@mail.ru\thttps://x.com', // T3 provider
  'b@user.br\thttps://y.com', // T3 email ccTLD
  'c@gmail.com\thttp://site.ru/login', // T3 by URL TLD
]

function run(script: string, extraEnv: Record<string, string>, auditRows: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'purge-guard-'))
  const stubPath = join(dir, 'docker')
  const callsPath = join(dir, 'calls.log')
  const auditPath = join(dir, 'audit.tsv')
  writeFileSync(stubPath, STUB_DOCKER)
  chmodSync(stubPath, 0o755)
  writeFileSync(callsPath, '')
  writeFileSync(auditPath, auditRows.map((r) => `${r}\n`).join(''))

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(INGEST_FILTER_|APPLY$|BACKUP_VERIFIED$|ACCEPT_PERMANENT_DATA_LOSS$|DOCKER_|CLICKHOUSE_)/.test(k)) env[k] = v
  }
  env.PATH = [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(':')
  env.DOCKER_HOST = 'unix:///nonexistent/docker.sock'
  env.STUB_CALLS = callsPath
  env.STUB_AUDIT = auditPath

  const probe = spawnSync('bash', ['-c', 'command -v docker'], { env, encoding: 'utf8' })
  if (probe.stdout.trim() !== stubPath) {
    throw new Error(`refusing to run: docker resolves to "${probe.stdout.trim()}", not the stub`)
  }

  const r = spawnSync('bash', [join(REPO, 'scripts', script)], {
    cwd: REPO,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 90_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', calls: readFileSync(callsPath, 'utf8') }
}

const submittedDelete = (calls: string) => /DELETE FROM ulp\.credentials|ALTER TABLE ulp\.credentials\s+DELETE/i.test(calls)

describe('test harness', () => {
  test('docker resolves to the recording stub, never a real daemon', () => {
    const r = run('tier-distribution.sh', {}, [])
    expect(r.calls).toContain('ulp.credentials') // the read-only script reached the stub
  }, 60_000)
})

describe('scripts/purge-existing-t3.sh', () => {
  const apply = { APPLY: '1', ACCEPT_PERMANENT_DATA_LOSS: '1' }

  test('apply mode refuses, and submits no DELETE, when the stored T3 label disagrees with the importer', () => {
    const r = run('purge-existing-t3.sh', apply, MISLABELED)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(/refusing/i)
    expect(r.stdout).toMatch(/no "@"/)
    expect(submittedDelete(r.calls)).toBe(false)
  }, 60_000)

  test('a dry run reports BLOCKED, exits 0 and submits nothing', () => {
    const r = run('purge-existing-t3.sh', {}, MISLABELED)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/BLOCKED/)
    expect(submittedDelete(r.calls)).toBe(false)
  }, 60_000)

  test('when every candidate really is T3 the purge still runs', () => {
    const r = run('purge-existing-t3.sh', apply, REAL_T3)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/T3 purge complete/)
    expect(submittedDelete(r.calls)).toBe(true)
  }, 60_000)
})

describe('scripts/purge-existing-low-tier.sh', () => {
  const policy = { INGEST_FILTER_DROP_TIERS: 'T3' }

  test('apply mode refuses, and submits no DELETE, when the stored tier disagrees with the importer', () => {
    const r = run('purge-existing-low-tier.sh', { ...policy, APPLY: '1' }, MISLABELED)
    expect(r.status).toBe(3)
    expect(r.stdout + r.stderr).toMatch(/refusing/i)
    expect(submittedDelete(r.calls)).toBe(false)
  }, 60_000)

  test('a dry run reports BLOCKED, exits 0 and submits nothing', () => {
    const r = run('purge-existing-low-tier.sh', policy, MISLABELED)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/BLOCKED/)
    expect(submittedDelete(r.calls)).toBe(false)
  }, 60_000)

  test('when every candidate really is dropped at ingest the purge still runs', () => {
    const r = run('purge-existing-low-tier.sh', { ...policy, APPLY: '1' }, REAL_T3)
    expect(r.status).toBe(0)
    expect(submittedDelete(r.calls)).toBe(true)
  }, 60_000)
})
