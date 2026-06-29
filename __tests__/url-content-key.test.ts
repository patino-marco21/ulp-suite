import { describe, test, expect } from 'vitest'
import { URL_CONTENT_KEY } from '@/lib/url-content-key'

describe('url-content-key', () => {
  test('strips a leading http:// or https:// (case-insensitive) and one trailing slash from url', () => {
    expect(URL_CONTENT_KEY).toBe(
      `replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', '')`
    )
  })
})
