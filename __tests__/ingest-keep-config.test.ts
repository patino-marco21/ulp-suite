import { readFileSync } from 'fs'
import { describe, expect, test } from 'vitest'
import { DEFAULT_HARD_KEEP_COUNTRIES } from '@/lib/ingest-filter'

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const compose = read('docker-compose.yml')
const rehearsal = read('docker-compose.rehearsal.yml')
const envExample = read('.env.example')
const readme = read('README.md')

describe('the keep-list reaches the container with the documented default', () => {
  test('docker-compose.yml: unset means the default list, an explicit empty value means none', () => {
    expect(compose).toContain(`INGEST_FILTER_HARD_KEEP_COUNTRIES: \${INGEST_FILTER_HARD_KEEP_COUNTRIES-${DEFAULT_HARD_KEEP_COUNTRIES}}`)
  })
  test('the rehearsal stack uses the same default and can run a candidate image', () => {
    expect(rehearsal).toContain(`INGEST_FILTER_HARD_KEEP_COUNTRIES: \${REHEARSAL_INGEST_FILTER_HARD_KEEP_COUNTRIES-${DEFAULT_HARD_KEEP_COUNTRIES}}`)
    expect(rehearsal.match(/image: \$\{REHEARSAL_APP_IMAGE:-ulp-suite-app:latest\}/g)).toHaveLength(2)
  })
  test('.env.example and the README document it', () => {
    expect(envExample).toContain(`INGEST_FILTER_HARD_KEEP_COUNTRIES=${DEFAULT_HARD_KEEP_COUNTRIES}`)
    expect(readme).toContain('INGEST_FILTER_HARD_KEEP_COUNTRIES')
  })
})
