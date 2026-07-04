import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('projection-scope-cron source contract', () => {
  const source = readFileSync(new URL('../lib/projection-scope-cron.ts', import.meta.url), 'utf8')

  test('reuses msUntilNextRun from dedup-cron instead of duplicating it', () => {
    expect(source).toContain("import { msUntilNextRun } from '@/lib/dedup-cron'")
  })
  test('anchors the first tick via msUntilNextRun, not a fixed startup delay', () => {
    expect(source).toContain('msUntilNextRun(')
    expect(source).not.toContain('}, 60_000)')
  })
})
