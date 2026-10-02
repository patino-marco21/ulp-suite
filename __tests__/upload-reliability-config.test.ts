import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

/** The `app:` service block (up to the next top-level service). */
const appService = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  # ─── clickhouse-backup'))

describe('import watchdog setting reaches the container', () => {
  test('IMPORT_STALL_TIMEOUT_MS is forwarded with an empty default (so the code default applies) and documented', () => {
    expect(appService).toContain('IMPORT_STALL_TIMEOUT_MS: ${IMPORT_STALL_TIMEOUT_MS:-}')
    expect(envExample).toContain('IMPORT_STALL_TIMEOUT_MS')
  })
})

const instrumentation = readFileSync(new URL('../instrumentation.ts', import.meta.url), 'utf8')

describe('upload spool settings reach the container', () => {
  test.each(['UPLOAD_SPOOL_DIR', 'UPLOAD_SPOOL_MIN_FREE_BYTES'])(
    '%s is forwarded with an empty default (so the code default applies) and documented',
    name => {
      expect(appService).toContain(`${name}: \${${name}:-}`)
      expect(envExample).toContain(name)
    },
  )

  test('the spool janitor is started from instrumentation in production only', () => {
    const prod = instrumentation.slice(instrumentation.indexOf("process.env.NODE_ENV === 'production'"))
    expect(prod).toContain("import('./lib/upload-spool')")
    expect(prod).toContain('startSpoolJanitor()')
  })
})
