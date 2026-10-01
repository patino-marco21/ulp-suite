import { describe, test, expect } from 'vitest'
import { isSchemeSplitRow, repairSchemeSplit, RepairStats, parseStoredRowLine, SCHEME_SPLIT_PREDICATE } from '@/lib/legacy-repair'
import { makeHardDropPredicate, parseIngestPolicy, shouldDropAtIngest } from '@/lib/ingest-filter'

const stored = (email: string, password: string, extra: Record<string, string> = {}) => ({
  url: 'https', email, password, source_file: 'combo.txt', ...extra,
})

describe('isSchemeSplitRow — the rows the old parser produced by splitting `https://host/path|login|pass` at the scheme colon', () => {
  test('the canonical shape: url is just the scheme, email is //host/path, the login and password are packed in password', () => {
    expect(isSchemeSplitRow(stored('//shop.example.com/login', 'alice@mail.com|hunter22'))).toBe(true)
    expect(isSchemeSplitRow({ ...stored('//shop.example.com', 'bob|pw1'), url: 'http' })).toBe(true)
  })

  test.each([
    ['another scheme', { url: 'ftp', email: '//h/p', password: 'a|b' }],
    ['the email does not start with //', { url: 'https', email: 'host/p', password: 'a|b' }],
    ['a space in the email (that is the case NORM_COLS already repairs)', { url: 'https', email: '//h/p x', password: 'a|b' }],
    ['no pipe in the password (nothing to split)', { url: 'https', email: '//h/p', password: 'justonepart' }],
    ['a pipe in the email (not this shape)', { url: 'https', email: '//h/p|x', password: 'a|b' }],
    ['a colon in the email (not this shape)', { url: 'https', email: '//h:8080/p', password: 'a|b' }],
    ['an ordinary row', { url: 'https://a.example/x', email: 'a@b.com', password: 'pw' }],
  ])('not: %s', (_why, row) => {
    expect(isSchemeSplitRow({ ...row, source_file: 'f' })).toBe(false)
  })
})

describe('SCHEME_SPLIT_PREDICATE — the same shape as a ClickHouse WHERE clause', () => {
  test('selects url http/https, a //-prefixed email without space, pipe or colon, and a password holding a pipe', () => {
    for (const part of ["url IN ('http','https')", "startsWith(email,'//')", "position(email,' ')=0", "position(email,'|')=0", "position(email,':')=0", "position(password,'|')>0"]) {
      expect(SCHEME_SPLIT_PREDICATE).toContain(part)
    }
  })
})

describe('repairSchemeSplit — re-parse the original line with the CURRENT parser', () => {
  test('recovers url, login, password and domain', () => {
    const r = repairSchemeSplit(stored('//shop.example.com/login', 'alice@mail.com|hunter22'))
    expect(r).toEqual({
      kind: 'repaired',
      credential: { url: 'https://shop.example.com/login', email: 'alice@mail.com', password: 'hunter22', domain: 'shop.example.com', source_file: 'combo.txt' },
    })
  })

  test('only the first pipe separates login from password', () => {
    const r = repairSchemeSplit(stored('//a.example.org/x', 'bob|pa|ss|word'))
    expect(r.kind === 'repaired' && r.credential).toMatchObject({ email: 'bob', password: 'pa|ss|word' })
  })

  test('a percent-encoded password is decoded the way the importer decodes it, and that is still lossless', () => {
    const r = repairSchemeSplit(stored('//a.example.org/x', 'carol|p%40ssw0rd'))
    expect(r.kind === 'repaired' && r.credential.password).toBe('p@ssw0rd')
  })

  test('applies the importer\'s hard-drop policy: a T3 row is not re-introduced', () => {
    const policy = makeHardDropPredicate(parseIngestPolicy({ INGEST_FILTER_HARD_DROP_TIERS: 'T3' } as NodeJS.ProcessEnv))
    expect(repairSchemeSplit(stored('//site.example.ru/login', 'x@mail.ru|secret1'), { shouldHardDrop: policy })).toEqual({ kind: 'rejected', reason: 'tier_dropped' })
    expect(repairSchemeSplit(stored('//site.example.ru/login', 'x@mail.ru|secret1')).kind).toBe('repaired')
  })

  test('the importer\'s other ingest drops apply too (here DROP_NOISE: a .php endpoint), not only the hard tiers', () => {
    const policy = parseIngestPolicy({ INGEST_FILTER_DROP_NOISE: 'true' } as NodeJS.ProcessEnv)
    const shouldDrop = (c: { email: string; url: string; domain: string }) => shouldDropAtIngest(c.email, c.url, c.domain, policy)
    const row = stored('//shop.example.com/wp-login.php', 'alice@mail.com|hunter22')
    expect(repairSchemeSplit(row, { shouldDrop })).toEqual({ kind: 'rejected', reason: 'policy_dropped' })
    expect(repairSchemeSplit(row).kind).toBe('repaired')
  })

  test('rows the parser rejects stay as they are, with the parser\'s reason', () => {
    expect(repairSchemeSplit(stored('//a.example.org/x', 'bob|ab'))).toEqual({ kind: 'rejected', reason: 'no_password' })
    expect(repairSchemeSplit(stored('//a.example.org/x', '|secret1'))).toEqual({ kind: 'rejected', reason: 'no_fields' })
  })

  test('never invents data: if the parser would change a field (here it trims the login) the row is left alone', () => {
    expect(repairSchemeSplit(stored('//a.example.org/x', ' bob|secret1'))).toEqual({ kind: 'rejected', reason: 'not_lossless' })
  })

  test('a row that is not the scheme-split shape is not touched', () => {
    expect(repairSchemeSplit({ url: 'https://a.example/x', email: 'a@b.com', password: 'pw1234', source_file: 'f' })).toEqual({ kind: 'rejected', reason: 'not_scheme_split' })
  })
})

describe('RepairStats', () => {
  test('counts candidates, repaired rows and the reasons for the rest', () => {
    const s = new RepairStats()
    s.add(repairSchemeSplit(stored('//a.example.org/x', 'bob|secret1')))
    s.add(repairSchemeSplit(stored('//a.example.org/x', 'bob|ab')))
    s.add(repairSchemeSplit(stored('//a.example.org/x', 'bob|ab')))
    expect(s.summary()).toEqual({ candidates: 3, repaired: 1, rejected: { no_password: 2 } })
  })
})

describe('parseStoredRowLine — ClickHouse TSV: url, email, password, source_file, breach_name, imported_at', () => {
  test('splits six tab-separated fields and undoes the TSV escapes', () => {
    const row = parseStoredRowLine('https\t//h.example/p\ta\\tb|pw\tfile.txt\tBreachName\t2026-07-24 05:14:13')
    expect(row).toEqual({ url: 'https', email: '//h.example/p', password: 'a\tb|pw', source_file: 'file.txt', breach_name: 'BreachName', imported_at: '2026-07-24 05:14:13' })
  })

  test('fewer than six fields is an error, not a silent skip', () => {
    expect(() => parseStoredRowLine('https\t//h/p\tpw')).toThrow()
  })
})
