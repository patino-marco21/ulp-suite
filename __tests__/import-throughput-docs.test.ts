import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('README import throughput docs', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

  it('documents the pipelining kill-switch', () => {
    expect(readme).toContain('IMPORT_PIPELINE')
  })
  it('documents configurable upload concurrency', () => {
    expect(readme).toContain('UPLOAD_CONCURRENCY')
  })
  it('documents the benchmark script', () => {
    expect(readme).toContain('scripts/benchmark-import.ts')
  })
})
