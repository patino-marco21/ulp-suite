import { describe, test, expect } from 'vitest'
import {
  SORT_MAP,
  encodeCursor,
  decodeCursor,
  buildCursorWhere,
  type SortKey,
} from '@/lib/cursor-pagination'

describe('SORT_MAP', () => {
  test('has all 8 sort keys', () => {
    const keys: SortKey[] = [
      'imported_desc', 'imported_asc',
      'domain_asc', 'domain_desc',
      'email_asc', 'email_desc',
      'pw_len_desc', 'pw_len_asc',
    ]
    for (const k of keys) expect(SORT_MAP[k]).toBeDefined()
  })

  test('domain_asc sorts plainly by domain (matches table ORDER BY prefix)', () => {
    expect(SORT_MAP['domain_asc']).toBe('domain ASC,  email ASC, imported_at ASC, url ASC, password ASC')
  })
})

describe('encodeCursor / decodeCursor', () => {
  test('round-trips imported_desc', () => {
    const row = { imported_at: '2024-01-01 00:00:00', domain: 'example.com', email: 'a@b.com', url: 'https://x', password: 'pass' }
    const token = encodeCursor('imported_desc', row)
    const payload = decodeCursor(token)
    expect(payload).not.toBeNull()
    expect(payload!.sort).toBe('imported_desc')
    expect(payload!.v.domain).toBe('example.com')
  })

  test('captures only CURSOR_COLS for each sort', () => {
    const row = { imported_at: '2024-01-01 00:00:00', domain: 'x.com', email: 'a@x.com', url: 'u', password: 'p', password_length: 8, extra_field: 'ignored' }
    const token = encodeCursor('pw_len_desc', row)
    const payload = decodeCursor(token)!
    expect(Object.keys(payload.v)).toEqual(['password_length', 'domain', 'email', 'imported_at', 'url'])
    expect(payload.v).not.toHaveProperty('password')
    expect(payload.v).not.toHaveProperty('extra_field')
  })

  test('decodeCursor returns null on empty string', () => {
    expect(decodeCursor('')).toBeNull()
  })

  test('decodeCursor returns null on malformed base64', () => {
    expect(decodeCursor('not-valid-base64!!!')).toBeNull()
  })

  test('decodeCursor returns null on valid base64 but invalid JSON', () => {
    const bad = Buffer.from('not json').toString('base64')
    expect(decodeCursor(bad)).toBeNull()
  })
})

describe('buildCursorWhere', () => {
  const baseRow = { imported_at: '2024-06-01 12:00:00', domain: 'test.com', email: 'u@test.com', url: 'https://test.com', password: 'abc' }

  test('imported_asc: tuple greater-than clause', () => {
    const payload = { sort: 'imported_asc' as SortKey, v: { ...baseRow } }
    const { clause, params } = buildCursorWhere('imported_asc', payload)
    expect(clause).toContain('(imported_at, domain, email, url, password) >')
    expect(Object.keys(params)).toEqual(expect.arrayContaining(['c_ia', 'c_d', 'c_e', 'c_u', 'c_pw']))
  })

  test('imported_desc: descending OR expansion', () => {
    const payload = { sort: 'imported_desc' as SortKey, v: { ...baseRow } }
    const { clause, params } = buildCursorWhere('imported_desc', payload)
    expect(clause).toContain('imported_at < {c_ia:DateTime}')
    expect(clause).toContain('imported_at = {c_ia:DateTime}')
    expect(params).toHaveProperty('c_ia')
  })

  test('domain_asc: tuple greater-than clause', () => {
    const payload = { sort: 'domain_asc' as SortKey, v: { ...baseRow } }
    const { clause, params } = buildCursorWhere('domain_asc', payload)
    expect(clause).toBe('(domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})')
    expect(Object.keys(params)).toEqual(expect.arrayContaining(['c_d', 'c_e', 'c_ia', 'c_u', 'c_pw']))
  })

  test('domain_desc: descending OR expansion', () => {
    const payload = { sort: 'domain_desc' as SortKey, v: { ...baseRow } }
    const { clause } = buildCursorWhere('domain_desc', payload)
    expect(clause).toContain('domain < {c_d:String}')
    expect(clause).toContain('domain = {c_d:String}')
  })

  test('email_asc: tuple greater-than', () => {
    const payload = { sort: 'email_asc' as SortKey, v: { ...baseRow } }
    const { clause } = buildCursorWhere('email_asc', payload)
    expect(clause).toContain('(email, domain, imported_at, url, password) >')
  })

  test('email_desc: descending OR expansion', () => {
    const payload = { sort: 'email_desc' as SortKey, v: { ...baseRow } }
    const { clause } = buildCursorWhere('email_desc', payload)
    expect(clause).toContain('email < {c_e:String}')
  })

  test('pw_len_asc: password_length > or equal with tiebreaker', () => {
    const payload = { sort: 'pw_len_asc' as SortKey, v: { ...baseRow, password_length: 8 } }
    const { clause, params } = buildCursorWhere('pw_len_asc', payload)
    expect(clause).toContain('password_length > {c_pl:UInt8}')
    expect(params).toHaveProperty('c_pl', 8)
  })

  test('pw_len_desc: password_length < or equal with tiebreaker', () => {
    const payload = { sort: 'pw_len_desc' as SortKey, v: { ...baseRow, password_length: 12 } }
    const { clause } = buildCursorWhere('pw_len_desc', payload)
    expect(clause).toContain('password_length < {c_pl:UInt8}')
  })

  test('all params use c_ prefix to avoid route param collisions', () => {
    for (const sort of ['imported_asc', 'imported_desc', 'email_asc', 'email_desc'] as SortKey[]) {
      const payload = { sort, v: { ...baseRow } }
      const { params } = buildCursorWhere(sort, payload)
      for (const key of Object.keys(params)) {
        expect(key.startsWith('c_')).toBe(true)
      }
    }
  })
})
