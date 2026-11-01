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
