import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher — memory-aware backpressure wiring', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports waitForHeadroom from lib/clickhouse-memory-guard', () => {
    expect(source).toMatch(/import\s*\{[^}]*waitForHeadroom[^}]*\}\s*from\s*['"]@\/lib\/clickhouse-memory-guard['"]/)
  })

  test('enqueueFile calls waitForHeadroom before claimFileForProcessing', () => {
    const fnStart = source.indexOf('uploadQueue(async')
    const claimIdx = source.indexOf('claimFileForProcessing(filePath, PROC)')
    expect(fnStart).toBeGreaterThan(-1)
    expect(claimIdx).toBeGreaterThan(fnStart)

    const fn = source.slice(fnStart, claimIdx)
    expect(fn).toContain('waitForHeadroom(')
  })
})
