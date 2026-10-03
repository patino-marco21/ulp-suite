import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const VARS = ['SEARCH_DICTIONARY', 'SEARCH_DICT_MAX_DOMAINS', 'SEARCH_DICT_MAX_EMAIL_DOMAINS', 'SEARCH_DICT_CRON_MINUTES', 'SEARCH_DICT_SETTLE_SECONDS']

describe('search dictionary wiring', () => {
  test('instrumentation starts the rebuild cron, in the production block only', () => {
    const src = read('instrumentation.ts')
    expect(src).toContain("await import('./lib/search-dictionary-cron')")
    expect(src).toContain('startSearchDictionaryCron()')
    expect(src.indexOf('startSearchDictionaryCron()')).toBeGreaterThan(src.indexOf("process.env.NODE_ENV === 'production'"))
  })

  test.each(VARS)('docker-compose forwards %s to the app (compose passes no other .env keys)', name => {
    expect(read('docker-compose.yml')).toContain(`${name}: \${${name}:-}`)
  })

  test.each(VARS)('.env.example documents %s', name => {
    expect(read('.env.example')).toContain(`# ${name}=`)
  })

  test('the README explains the feature, its first build, and how to switch it off', () => {
    const readme = read('README.md')
    expect(readme).toContain('### Domain search dictionary')
    expect(readme).toContain('scripts/build-search-dictionary.ts')
    expect(readme).toContain('SEARCH_DICTIONARY=0')
    expect(readme).toContain('dictionary=0')
  })

  test('the backup script leaves the derived tables (and their shadow copies) out of the default list', () => {
    const script = read('scripts/clickhouse-backup.sh')
    expect(script).toContain("NOT match(name, '^(credentials_|zz_|search_)')")
    expect(script).toContain('search_host_dict')
  })

  test('the rehearsal stack runs the cron fast, so scripts/e2e-search-dictionary.ts can watch the dictionary rebuild itself', () => {
    const compose = read('docker-compose.rehearsal.yml')
    expect(compose).toContain('SEARCH_DICT_CRON_MINUTES: "1"')
    expect(compose).toContain('SEARCH_DICT_SETTLE_SECONDS: "5"')
  })
})
