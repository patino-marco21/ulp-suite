import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('pagination import docs', () => {
  test('documents the resilient large-file import contract', () => {
    const readme = readFileSync('README.md', 'utf8')

    expect(readme).toContain('200 rows per page')
    expect(readme).toContain('Domain A→Z')
    expect(readme).toContain('100,000-row synchronous batches')
    expect(readme).toContain('temporary ClickHouse outages')
    expect(readme).toContain('scheduled or manual dedup')
  })
})
