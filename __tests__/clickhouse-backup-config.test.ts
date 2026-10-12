/** Found by rehearsing the S3 path against a throwaway MinIO (2026-10-12): see docs/superpowers/specs/2026-10-12-parser-v6-and-redo-design.md. */
import { readFileSync } from 'fs'
import { describe, expect, test } from 'vitest'

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const config = read('docker/clickhouse-backup/config.yml')
const script = read('scripts/clickhouse-backup.sh')
const compose = read('docker-compose.yml')
const backupService = compose.slice(compose.indexOf('\n  clickhouse-backup:'), compose.indexOf('\nvolumes:'))
const runbook = read('docs/clickhouse-backup-runbook.md')

describe('clickhouse-backup configuration', () => {
  test('the replica path of a restore under another database name uses the macros this server has (no {cluster})', () => {
    expect(config).toMatch(/default_replica_path:\s*"?\/clickhouse\/tables\/\{shard\}\/\{database\}\/\{table\}"?/)
    expect(config.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')).not.toContain('{cluster}')   // the comment may name it
  })
  test('the compose service forwards the two S3 booleans with a valid default (MinIO and other self-hosted targets need both)', () => {
    expect(backupService).toContain('S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-false}')
    expect(backupService).toContain('S3_DISABLE_SSL: ${S3_DISABLE_SSL:-false}')
  })
})

describe('scripts/clickhouse-backup.sh', () => {
  test("verify restores with a single 'ulp.*' pattern (a comma list under a database mapping matches no table) after clearing a stale local copy", () => {
    const verify = script.slice(script.indexOf('  verify)'), script.indexOf('  restore)'))
    expect(verify).toContain(`restore_remote --rm --restore-database-mapping ulp:ulp_verify --tables 'ulp.*' "$base"`)
    expect(verify).toContain('delete local "$base"')
    expect(verify).not.toContain('--tables "$TABLES"')
  })
  test('BACKUP_PARTITIONS limits a backup to static partitions', () => {
    expect(script).toContain('BACKUP_PARTITIONS')
    expect(script.match(/\$\{BACKUP_PARTITIONS:\+--partitions "\$BACKUP_PARTITIONS"\}/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the runbook', () => {
  test('documents S3-compatible targets and the first backup of the static partitions', () => {
    expect(runbook).toContain('S3_FORCE_PATH_STYLE')
    expect(runbook).toContain('BACKUP_PARTITIONS=202607,202608')
  })
})
