import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const instrumentation = readFileSync(new URL('../instrumentation.ts', import.meta.url), 'utf8')

/** The `app:` service block (up to the next top-level service). */
const appService = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  # ─── clickhouse-backup'))
const clickhouseService = compose.slice(compose.indexOf('\n  clickhouse:'), compose.indexOf('\n  # ─── App'))

describe('docker-compose — network exposure', () => {
  test('the app port is published on loopback unless APP_BIND_ADDR says otherwise', () => {
    expect(appService).toContain('"${APP_BIND_ADDR:-127.0.0.1}:3000:3000"')
    expect(appService).not.toMatch(/-\s+"3000:3000"/)
  })

  test('the container still listens on every interface (the published address is what restricts it)', () => {
    expect(appService).toContain('HOSTNAME: "0.0.0.0"')
  })

  test('ClickHouse publishes no host port', () => {
    expect(clickhouseService).not.toMatch(/^\s+ports:/m)
  })

  test('.env.example documents the knob and the 2FA caveat', () => {
    expect(envExample).toContain('APP_BIND_ADDR')
    expect(envExample).toMatch(/enrol 2FA/)
  })
})

describe('docker-compose — disk watcher settings reach the container', () => {
  test.each([
    'DISK_WATCH_MINUTES',
    'DISK_WARN_FREE_BYTES',
    'DISK_WARN_FREE_RATIO',
    'DISK_ALERT_WEBHOOK_URL',
    'DISK_ALERT_REMINDER_HOURS',
    'DISK_GUARD_MIN_FREE_BYTES',
    'DISK_GUARD_MIN_FREE_RATIO',
  ])('%s is forwarded with an empty default (so the code default applies)', name => {
    expect(appService).toContain(`${name}: \${${name}:-}`)
    expect(envExample).toContain(name)
  })

  test('the webhook is opt-in: no default URL anywhere', () => {
    expect(appService).not.toMatch(/DISK_ALERT_WEBHOOK_URL: \$\{DISK_ALERT_WEBHOOK_URL:-[^}]/)
    expect(envExample).toMatch(/^#\s+DISK_ALERT_WEBHOOK_URL=/m)
    expect(envExample).not.toMatch(/^DISK_ALERT_WEBHOOK_URL=/m)
  })

  test('the cron is started from instrumentation in production only', () => {
    const prod = instrumentation.slice(instrumentation.indexOf("process.env.NODE_ENV === 'production'"))
    expect(prod).toContain("import('./lib/disk-watch-cron')")
    expect(prod).toContain('startDiskWatchCron()')
  })
})

describe('backup tooling — what it must never do', () => {
  const script = readFileSync(new URL('../scripts/clickhouse-backup.sh', import.meta.url), 'utf8')
  const config = readFileSync(new URL('../docker/clickhouse-backup/config.yml', import.meta.url), 'utf8')

  test('never backs up `ulp.*`: that would snapshot and upload the 381 GiB pre-dedup archive', () => {
    expect(script).not.toMatch(/TABLES="ulp\.\*"/)
    expect(script).not.toMatch(/--tables\s+"?ulp\.\*/)
    // the default list excludes the archive, the scratch tables and the derived search dictionary (and its __new shadow copies) by name
    expect(script).toContain("NOT match(name, '^(credentials_|zz_|search_)')")
  })

  test('every command that snapshots runs the disk-space guard first', () => {
    for (const cmd of ['full', 'inc|incremental', 'local']) {
      const start = script.indexOf(`  ${cmd})`)
      expect(start).toBeGreaterThan(-1)
      const block = script.slice(start, script.indexOf(';;', start))
      expect(block).toContain('space_guard')
      expect(block.indexOf('space_guard')).toBeLessThan(block.search(/create(_remote)? /))
    }
  })

  test('S3 uploads delete their local copy afterwards, and local retention is small', () => {
    expect(script).toMatch(/create_remote --delete-source/)
    expect(config).toMatch(/backups_to_keep_local:\s*2\b/)
  })

  test('the guard exits non-zero (2), so cron fails loudly instead of eating the headroom', () => {
    expect(script).toMatch(/exit 2/)
  })

  test('the status file the app reads is written through the app container, and a failure there never fails the backup', () => {
    expect(script).toContain('docker exec -i "$APP" sh -c')
    expect(script).toMatch(/clickhouse-last\.json/)
    expect(script).toMatch(/\|\|\s*warn "Could not record/)
  })
})
