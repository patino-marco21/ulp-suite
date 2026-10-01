import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, test, expect } from 'vitest'
import { NORM_COLS, NORM_COLS_SETTING } from '@/lib/ulp-normalize'
import { RELATED_BY_EMAIL_SQL, RELATED_BY_DOMAIN_SQL, RELATED_BY_PASSWORD_SQL } from '@/lib/related-queries'

const root = new URL('..', import.meta.url).pathname

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next') return []
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

describe('NORM_COLS must be selected with prefer_column_name_to_alias = 1', () => {
  // Measured 2026-10-01 on 20,000 well-formed Case D rows: with ClickHouse's default alias resolution NORM_COLS's own
  // aliases (url, email, password, domain) shadow the columns its expressions read, so a Case D row came out half
  // repaired (real domain, URL still in the email column, password stripped of its login). With the setting: repaired.
  test('the setting is the one that was measured', () => {
    expect(NORM_COLS_SETTING).toBe('prefer_column_name_to_alias = 1')
  })

  test('every module that interpolates NORM_COLS into a query also carries the setting', () => {
    const users = [...sourceFiles(join(root, 'app')), ...sourceFiles(join(root, 'lib'))]
      .filter(f => !f.endsWith('lib/ulp-normalize.ts'))
      .filter(f => readFileSync(f, 'utf8').includes('${NORM_COLS}'))
    // credentials, export, search, related, v1 batch lookup -- if this list shrinks, a route stopped using it
    expect(users.map(f => f.replace(root, '')).sort()).toEqual([
      'app/api/credentials/route.ts',
      'app/api/export/route.ts',
      'app/api/search/route.ts',
      'app/api/v1/lookup/batch/route.ts',
      'lib/related-queries.ts',
    ])
    for (const f of users) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} selects NORM_COLS without NORM_COLS_SETTING`).toContain('${NORM_COLS_SETTING}')
    }
  })

  test('the setting sits in the SETTINGS clause of the query that selects NORM_COLS, not in a comment', () => {
    for (const rel of ['app/api/credentials/route.ts', 'app/api/export/route.ts', 'app/api/search/route.ts', 'app/api/v1/lookup/batch/route.ts']) {
      const src = readFileSync(join(root, rel), 'utf8')
      const uses = [...src.matchAll(/^[^/\n]*\$\{NORM_COLS_SETTING\}/gm)]
      expect(uses.length, rel).toBeGreaterThan(0)
    }
  })

  test.each([
    ['by_email', RELATED_BY_EMAIL_SQL],
    ['by_domain', RELATED_BY_DOMAIN_SQL],
    ['by_password', RELATED_BY_PASSWORD_SQL],
  ])('related %s query carries it after its other settings', (_name, sql) => {
    expect(sql).toContain(`use_query_cache = 0, ${NORM_COLS_SETTING}`)
    expect(sql).toContain(NORM_COLS)
  })

  test('the fragment itself is unchanged: the fix is a setting, not new SQL', () => {
    expect(NORM_COLS).toContain('AS url')
    expect(NORM_COLS).toContain('AS domain')
    expect(NORM_COLS).not.toContain('prefer_column_name_to_alias')
  })
})
