import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

describe('CI workflow', () => {
  test('pins the runner image: ubuntu-latest moves to Ubuntu 26 on 2026-10-19', () => {
    expect(ci).toContain('runs-on: ubuntu-24.04')
    expect(ci).not.toContain('ubuntu-latest')
  })

  test('uses action majors that run on Node 24 natively', () => {
    expect(ci).toContain('actions/checkout@v7')
    expect(ci).toContain('actions/setup-node@v7')
    expect(ci).not.toMatch(/actions\/(checkout|setup-node)@v[1-4]\b/)
  })
})
