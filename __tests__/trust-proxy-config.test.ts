import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

describe('TRUST_PROXY_HOPS is wired through and documented', () => {
  test('docker-compose forwards it to the app, defaulting to 0 (no proxy)', () => {
    // Compose does not inject arbitrary .env keys: a setting that is not listed here never reaches the app.
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain('TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-0}')
  })

  test('.env.example explains what it does and what the default means', () => {
    const env = readFileSync('.env.example', 'utf8')
    expect(env).toContain('TRUST_PROXY_HOPS')
    expect(env).toMatch(/X-Forwarded-For/)
    expect(env).toMatch(/default/i)
  })

  test('the README says when to set it and what changes without it', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain('TRUST_PROXY_HOPS')
    expect(readme).toMatch(/reverse proxy/i)
    expect(readme).toMatch(/\/api\/check/)
  })
})
