import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_CREDENTIAL_LIMIT,
  DEFAULT_CREDENTIAL_SORT,
  MAX_CREDENTIAL_LIMIT,
} from '@/lib/credential-browse-defaults'

describe('credential browse defaults', () => {
  test('defaults to 200 rows ordered globally by domain A to Z', () => {
    expect(DEFAULT_CREDENTIAL_LIMIT).toBe(200)
    expect(MAX_CREDENTIAL_LIMIT).toBe(200)
    expect(DEFAULT_CREDENTIAL_SORT).toBe('domain_asc')
  })

  test('the UI and API consume the shared defaults', () => {
    const page = readFileSync('app/credentials/page.tsx', 'utf8')
    const route = readFileSync('app/api/credentials/route.ts', 'utf8')
    expect(page).toContain('useState(DEFAULT_CREDENTIAL_SORT)')
    expect(page).toContain('useState(DEFAULT_CREDENTIAL_LIMIT)')
    expect(route).toContain("sp.get('sort') || DEFAULT_CREDENTIAL_SORT")
    expect(route).toContain("sp.get('limit') || String(DEFAULT_CREDENTIAL_LIMIT)")
  })
})
