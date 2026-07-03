import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('url-content-key docs', () => {
  const readme = readFileSync('README.md', 'utf8')

  test('README describes the dedupe key as scheme/slash-insensitive, not exact', () => {
    expect(readme).toContain('ignoring URL scheme and a trailing slash')
  })
})
