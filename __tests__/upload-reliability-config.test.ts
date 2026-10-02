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
