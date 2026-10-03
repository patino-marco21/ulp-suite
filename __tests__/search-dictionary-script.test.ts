import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

const script = readFileSync('scripts/build-search-dictionary.ts', 'utf8')

describe('scripts/build-search-dictionary.ts', () => {
  test('runs the same build function the cron calls, and can only print the status', () => {
    expect(script).toContain("from '@/lib/search-dictionary'")
    expect(script).toContain('buildSearchDictionary(')
    expect(script).toContain("'--status'")
    expect(script).toContain("'--force'")
    expect(script).toContain("'--skip-headroom-check'")
  })

  test('tells the operator how to reach ClickHouse from the host, and that nothing is exposed', () => {
    expect(script).toContain('docker inspect ulpsuite_clickhouse')
    expect(script).toContain('CLICKHOUSE_HOST=http://$IP:8123')
  })

  test('refuses to start a second build and says what a stale answer right after a build means', () => {
    expect(script).toContain("status.state === 'building'")
    expect(script).toContain('exit code 3')
  })
})
