import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

describe('WEBHOOK_ALLOW_PRIVATE_HOSTS is wired through and documented', () => {
  test('docker-compose forwards it to the app, empty (off) by default', () => {
    // Compose does not inject arbitrary .env keys: a setting that is not listed here never reaches the app, and the
    // refusal message tells the operator to set exactly this one.
    expect(readFileSync('docker-compose.yml', 'utf8')).toContain('WEBHOOK_ALLOW_PRIVATE_HOSTS: ${WEBHOOK_ALLOW_PRIVATE_HOSTS:-}')
  })

  test('.env.example and the README say what it allows and that the default is public addresses only', () => {
    for (const file of ['.env.example', 'README.md']) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).toContain('WEBHOOK_ALLOW_PRIVATE_HOSTS')
      expect(text, file).toMatch(/public address/i)
    }
  })
})
