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
    expect(readme).toContain('Existing failed files must be retried from the Inbox Monitor after deployment:')
    expect(readme).toContain('# Or click "Retry All" in the Inbox Monitor UI')
    expect(readme).toContain('permanent or semantic failures still move the file to `./inbox/failed/`')
    expect(readme).toContain('The old post-file full-table dedup pass is removed; scheduled or manual dedup remains available.')
    expect(readme).toContain('bash scripts/dedup-credentials-content.sh')
    expect(readme).not.toContain('/api/admin/dedup')
  })
})
