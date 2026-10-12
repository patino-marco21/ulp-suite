/** insertBatch used to yield one stream chunk per CSV row (1.57 us/row). It now yields 2000 rows per chunk; the bytes must not change. */
import { describe, expect, test } from 'vitest'
import { csvChunks, csvField, CSV_ROWS_PER_CHUNK } from '@/lib/upload-csv'
import type { ULPCredential } from '@/lib/ulp-parser'

// ── the code this replaced, verbatim ──
const refCsvField = (v: string): string => '"' + v.replace(/"/g, '""') + '"'
function refRows(credentials: ULPCredential[], breach_name: string): string {
  let out = ''
  for (const c of credentials) {
    out += [refCsvField(c.url), refCsvField(c.email), refCsvField(c.password), refCsvField(c.domain), refCsvField(c.source_file), refCsvField(breach_name)].join(',') + '\n'
  }
  return out
}

const cred = (n: number, o: Partial<ULPCredential> = {}): ULPCredential => ({
  url: `https://shop${n}.example.test/login`, email: `user${n}@mail.test`, password: `Pw${n}`, domain: `shop${n}.example.test`, source_file: `f${n % 7}.txt`, ...o,
})
const tricky: ULPCredential[] = [
  cred(1, { password: 'say "hi"' }), cred(2, { password: '""' }), cred(3, { password: 'line\nbreak' }), cred(4, { password: 'tab\there,comma' }),
  cred(5, { password: 'café Иван 😀' }), cred(6, { url: '', email: '', password: '', domain: '' }), cred(7, { password: 'a"b"c"' }), cred(8, { password: ',' }),
]

describe('csvField', () => {
  test.each(['', 'plain', 'a"b', '"', '""', 'new\nline', 'Иван', ' '])('%j is quoted exactly as before', v => expect(csvField(v)).toBe(refCsvField(v)))
})

describe('csvChunks', () => {
  test.each([1, 2, 3, 7, CSV_ROWS_PER_CHUNK])('chunks of %i rows join to the same bytes as the per-row code', k => {
    const batch = Array.from({ length: 50 }, (_, i) => cred(i)).concat(tricky)
    expect([...csvChunks(batch, 'Breach "X"', k)].join('')).toBe(refRows(batch, 'Breach "X"'))
  })
  test('the chunk size is the number of rows per yielded string', () => {
    const batch = Array.from({ length: 4001 }, (_, i) => cred(i))
    const chunks = [...csvChunks(batch, 'B')]
    expect(chunks).toHaveLength(3)
    expect(chunks.map(c => c.split('\n').length - 1)).toEqual([2000, 2000, 1])
    expect(chunks.join('')).toBe(refRows(batch, 'B'))
  })
  test('an empty batch yields nothing', () => {
    expect([...csvChunks([], 'B')]).toEqual([])
  })
})
