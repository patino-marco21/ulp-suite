import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const NAMES = ['MEMORY_GUARD_THRESHOLD_RATIO', 'MEMORY_GUARD_MAX_WAIT_MS']

describe('memory guard variables', () => {
  for (const name of NAMES) {
    test(`${name} is forwarded by the production compose file, shown in .env.example and described in the README`, () => {
      expect(read('docker-compose.yml')).toContain(`${name}: \${${name}:-}`)
      expect(read('.env.example')).toContain(`# ${name}=`)
      expect(read('README.md')).toContain('`' + name + '`')
    })
  }

  test('the defaults the docs state are the ones in the code', () => {
    const code = read('lib/clickhouse-memory-guard.ts')
    expect(code).toContain('process.env.MEMORY_GUARD_THRESHOLD_RATIO, 0.75')
    expect(code).toContain('process.env.MEMORY_GUARD_MAX_WAIT_MS, 10 * 60 * 1_000')
    expect(read('.env.example')).toContain('# MEMORY_GUARD_THRESHOLD_RATIO=0.75')
    expect(read('.env.example')).toContain('# MEMORY_GUARD_MAX_WAIT_MS=600000')
  })
})
