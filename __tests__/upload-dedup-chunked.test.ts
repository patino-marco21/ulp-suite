/** batchDedupToken made 10 md5.update calls per row (1.61 us/row). It now updates once per 2000 rows; the digest must not change. */
import crypto from 'crypto'
import { describe, expect, test } from 'vitest'
import { batchDedupToken } from '@/lib/upload-dedup'
import type { ULPCredential } from '@/lib/ulp-parser'

// ── the code this replaced, verbatim ──
function refToken(credentials: ULPCredential[], breach_name: string): string {
  const h = crypto.createHash('md5')
  for (const c of credentials) {
    h.update(c.url); h.update('\x00'); h.update(c.email); h.update('\x00'); h.update(c.password); h.update('\x00')
    h.update(c.domain); h.update('\x00'); h.update(c.source_file); h.update('\x01')
  }
  h.update('\x02')
  h.update(breach_name)
  return h.digest('hex')
}

const pool = ['', 'a', 'https://shop.example.test/login', 'user@mail.test', 'Secret1', 'café', 'Иван', '😀', 'x\ud800', '\udc00y', 'q"r', 'line\nbreak']
const cred = (i: number): ULPCredential => ({
  url: pool[i % pool.length], email: pool[(i * 3 + 1) % pool.length], password: pool[(i * 5 + 2) % pool.length] + i, domain: pool[(i * 7) % pool.length], source_file: `f${i % 3}.txt`,
})

describe('batchDedupToken', () => {
  test.each([0, 1, 2, 1999, 2000, 2001, 4000, 4001, 7777])('%i rows: same digest as the per-field code', n => {
    const batch = Array.from({ length: n }, (_, i) => cred(i))
    expect(batchDedupToken(batch, 'Breach')).toBe(refToken(batch, 'Breach'))
  })
  test('lone surrogates at the end of a field do not pair with the next field', () => {
    const batch: ULPCredential[] = [{ url: 'u\ud83d', email: '\ude00e', password: 'p', domain: 'd', source_file: 's' }]
    expect(batchDedupToken(batch, 'B')).toBe(refToken(batch, 'B'))
  })
})
