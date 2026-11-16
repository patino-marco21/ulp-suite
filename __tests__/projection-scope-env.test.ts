import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { projectionScopeWindowMonths } from '@/lib/projection-scope'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const NAME = 'PROJECTION_SCOPE_WINDOW_MONTHS'

describe(NAME, () => {
  test('is forwarded by the production compose file, shown in .env.example and described in the README', () => {
    expect(read('docker-compose.yml')).toContain(`${NAME}: \${${NAME}:-}`)
    expect(read('.env.example')).toContain(`# ${NAME}=2`)
    expect(read('README.md')).toContain('`' + NAME + '`')
  })

  test('an empty value (what compose forwards when it is unset) means the default of 2, and 1 is honoured', () => {
    expect(projectionScopeWindowMonths({ [NAME]: '' })).toBe(2)
    expect(projectionScopeWindowMonths({})).toBe(2)
    expect(projectionScopeWindowMonths({ [NAME]: '1' })).toBe(1)
    expect(projectionScopeWindowMonths({ [NAME]: '0' })).toBe(2)
  })
})

describe('ClickHouse system-log retention', () => {
  test('every high-volume log has a TTL, text_log and query_metric_log included', () => {
    const xml = read('docker/clickhouse/config/ulp-system-logs.xml')
    for (const log of ['text_log', 'query_metric_log', 'trace_log', 'query_log']) {
      expect(xml).toMatch(new RegExp(`<${log}>\\s*<ttl>event_date \\+ INTERVAL \\d+ DAY DELETE</ttl>\\s*</${log}>`))
    }
  })
})
