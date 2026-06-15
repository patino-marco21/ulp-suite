import { describe, it, expect } from 'vitest'
import { batchDedupToken } from '@/lib/upload-dedup'
import type { ULPCredential } from '@/lib/ulp-parser'

const cred = (o: Partial<ULPCredential>): ULPCredential => ({
  url: '', email: '', password: '', domain: '', source_file: 'f.txt', ...o,
})

describe('batchDedupToken', () => {
  it('returns the same token for byte-identical batches (so a re-imported file dedups)', () => {
    const a = [
      cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' }),
      cred({ url: 'https://b.com', email: 'b@b.com', password: 'p2', domain: 'b.com' }),
    ]
    const reimport = [
      cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', domain: 'a.com' }),
      cred({ url: 'https://b.com', email: 'b@b.com', password: 'p2', domain: 'b.com' }),
    ]
    expect(batchDedupToken(a, 'breachX')).toBe(batchDedupToken(reimport, 'breachX'))
  })

  it('returns a different token when any field differs (new/changed data is NOT deduped away)', () => {
    const base    = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1' })]
    const changed = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'CHANGED' })]
    expect(batchDedupToken(base, 'breachX')).not.toBe(batchDedupToken(changed, 'breachX'))
  })

  it('namespaces by source_file so identical creds from different files are kept (provenance)', () => {
    const f1 = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', source_file: 'file1.txt' })]
    const f2 = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1', source_file: 'file2.txt' })]
    expect(batchDedupToken(f1, 'breachX')).not.toBe(batchDedupToken(f2, 'breachX'))
  })

  it('differs when breach_name differs (token reflects the full insert payload)', () => {
    const batch = [cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1' })]
    expect(batchDedupToken(batch, 'breachA')).not.toBe(batchDedupToken(batch, 'breachB'))
  })

  it('is order-sensitive (row order is part of the batch identity)', () => {
    const r1 = cred({ url: 'https://a.com', email: 'a@a.com', password: 'p1' })
    const r2 = cred({ url: 'https://b.com', email: 'b@b.com', password: 'p2' })
    expect(batchDedupToken([r1, r2], 'b')).not.toBe(batchDedupToken([r2, r1], 'b'))
  })

  it('produces a stable fixed-length hex token', () => {
    expect(batchDedupToken([cred({ url: 'x' })], 'b')).toMatch(/^[0-9a-f]{32}$/)
  })
})
