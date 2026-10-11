import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher — ingest disk gate wiring', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports waitForDiskSpace from lib/ingest-disk-gate', () => {
    expect(source).toMatch(/import\s*\{[^}]*waitForDiskSpace[^}]*\}\s*from\s*['"]@\/lib\/ingest-disk-gate['"]/)
  })

  test('the queued task waits for disk space before the memory guard, and both before the file is claimed', () => {
    const fnStart = source.indexOf('uploadQueue(async')
    const gateIdx = source.indexOf('waitForDiskSpace(', fnStart)
    const memIdx = source.indexOf('waitForHeadroom(', fnStart)
    const claimIdx = source.indexOf('claimFileForProcessing(filePath, PROC)')
    expect(fnStart).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(fnStart)
    expect(memIdx).toBeGreaterThan(gateIdx)
    expect(claimIdx).toBeGreaterThan(memIdx)
  })
})
