import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** The `app:` service block (up to the next top-level service). */
const appService = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  # ─── clickhouse-backup'))

describe('ingest disk gate settings reach the container', () => {
  test.each(['INGEST_MIN_FREE_BYTES', 'INGEST_DISK_GATE'])(
    '%s is forwarded with an empty default (so the code default applies) and documented',
    name => {
      expect(appService).toContain(`${name}: \${${name}:-}`)
      expect(envExample).toContain(name)
      expect(readme).toContain(name)
    },
  )
})
