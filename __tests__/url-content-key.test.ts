import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'
import {
  NORM_CONTENT_KEY,
  URL_CONTENT_KEY,
  exactKeySql,
  normHostSql,
  normKeySql,
  normRestSql,
} from '@/lib/url-content-key'

const S = `replaceRegexpOne(url, '^(?i:https?://)', '')`

describe('url-content-key', () => {
  test('strips a leading http:// or https:// (case-insensitive) and one trailing slash from url', () => {
    expect(URL_CONTENT_KEY).toBe(
      `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
    )
  })

  test('the exact key over the table columns is the one the live table and the stage define', () => {
    expect(exactKeySql()).toBe(`cityHash64(${URL_CONTENT_KEY}, email, password)`)
  })

  test('the exact key can be computed over other expressions, as the per-file recount does', () => {
    expect(exactKeySql({ url: 'unhex(u)', email: 'unhex(e)', password: 'unhex(p)' })).toBe(
      `cityHash64(replaceRegexpOne(replaceRegexpOne(unhex(u), '^(?i:https?://)', ''), '/$', ''), unhex(e), unhex(p))`,
    )
  })
})

describe('the normalised key', () => {
  test('the host part has no leading www., is lower case, and ends at the first / ? or #', () => {
    expect(normHostSql()).toBe(String.raw`lower(extract(${S}, '^(?i:www\\.)?([^/?#]*)'))`)
  })

  test('the rest of the URL is as typed, without any trailing slash', () => {
    expect(normRestSql()).toBe(String.raw`extract(${S}, '^[^/?#]*(.*?)/*$')`)
  })

  test('the key text is locked: host and rest, the login in lower case, the password as typed', () => {
    expect(NORM_CONTENT_KEY).toBe(
      String.raw`cityHash64(concat(lower(extract(${S}, '^(?i:www\\.)?([^/?#]*)')), extract(${S}, '^[^/?#]*(.*?)/*$')), lower(email), password)`,
    )
    expect(normKeySql()).toBe(NORM_CONTENT_KEY)
  })

  test('over other expressions it lower-cases the login only', () => {
    const key = normKeySql({ url: 'unhex(u)', email: 'unhex(e)', password: 'unhex(p)' })
    expect(key).toContain('lower(unhex(e)), unhex(p))')
    expect(key).not.toContain('lower(unhex(p))')
    expect(key).not.toMatch(/\burl\b/)
  })
})

const squash = (s: string) => s.replace(/\s+/g, '')
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the normalised key is defined once and copied to the places plain SQL cannot import it', () => {
  test('the init SQL defines norm_key_hash with exactly the TypeScript text', () => {
    expect(squash(read('docker/clickhouse/init/01-ulp-tables.sql'))).toContain(`norm_key_hashUInt64MATERIALIZED${squash(NORM_CONTENT_KEY)}`)
  })

  test('DDL v30 adds the column from the same constant and does not fire the backfill', () => {
    const migrations = read('lib/clickhouse-migrations.ts')
    expect(squash(migrations)).toContain(squash('ADD COLUMN IF NOT EXISTS norm_key_hash UInt64 MATERIALIZED ${NORM_CONTENT_KEY}'))
    expect(migrations).not.toMatch(/MATERIALIZE COLUMN norm_key_hash/)
  })
})
