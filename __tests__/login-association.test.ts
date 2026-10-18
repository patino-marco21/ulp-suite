import { describe, test, expect } from 'vitest'
import {
  ASSOCIATE_LIMITS,
  PASSWORD_LOOKUP_LIMITS,
  associateLogin,
  buildPasswordLookupSql,
  confidenceOf,
  lookupPassword,
  newCandidateState,
  parseAssociateItem,
  parsePasswordLookup,
  tokenClause,
  type AssociateItem,
  type CandidateState,
  type QueryRunner,
} from '@/lib/login-association'

// Every name, site and password below is synthetic: the repository is public.
const PW = 'Sup3rSecretPw' // 13 characters: long enough to count as cross-site evidence

type Row = Record<string, unknown>
type Handler = (tag: string, sql: string, params: Record<string, unknown>) => Row[] | Error

function runnerOf(handler: Handler) {
  const calls: Array<{ tag: string; sql: string; params: Record<string, unknown> }> = []
  const run: QueryRunner = async (sql, params) => {
    const tag = /^\s*\/\* assoc:(\w+) \*\//.exec(sql)?.[1] ?? 'untagged'
    calls.push({ tag, sql, params })
    const out = handler(tag, sql, params)
    if (out instanceof Error) throw out
    return out
  }
  return { run, calls }
}

const item = (over: Partial<AssociateItem> = {}): AssociateItem => ({ login: 'alice_w', want: 'email', ...over })

describe('parseAssociateItem', () => {
  test('a login alone is enough; it is trimmed, its case is kept, and the wanted kind defaults to email', () => {
    expect(parseAssociateItem({ login: '  Alice_W ' })).toEqual({ ok: true, item: { login: 'Alice_W', want: 'email' } })
  })

  test('the optional password and site come through, the site lowercased and without a leading www.', () => {
    const r = parseAssociateItem({ login: 'alice_w', password: PW, site: ' WWW.Example-Site.test ', want: 'username' })
    expect(r).toEqual({ ok: true, item: { login: 'alice_w', want: 'username', password: PW, site: 'example-site.test' } })
  })

  test.each([
    ['not an object', 'alice'],
    ['no login', {}],
    ['a login that is not a string', { login: 42 }],
    ['an empty login', { login: '   ' }],
    ['a login longer than the limit', { login: 'a'.repeat(ASSOCIATE_LIMITS.maxLoginLength + 1) }],
    ['a login with a control character', { login: 'ali\u0000ce' }],
    ['a password that is not a string', { login: 'a', password: 1 }],
    ['a password longer than the limit', { login: 'a', password: 'p'.repeat(ASSOCIATE_LIMITS.maxPasswordLength + 1) }],
    ['a site that is a URL', { login: 'a', site: 'https://example.test/path' }],
    ['a site with a space', { login: 'a', site: 'exa mple.test' }],
    ['an unknown wanted kind', { login: 'a', want: 'fax' }],
  ])('rejects %s', (_name, raw) => {
    const r = parseAssociateItem(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(5)
  })

  test('an empty password or site means "not given"', () => {
    expect(parseAssociateItem({ login: 'a', password: '', site: '' })).toEqual({ ok: true, item: { login: 'a', want: 'email' } })
  })
})

describe('tokenClause', () => {
  test('one parameterised hasToken per distinct lowercase word of the login', () => {
    const t = tokenClause('Alice_W-42_alice')
    expect(t.params).toEqual({ t0: 'alice', t1: 'w', t2: '42' })
    expect(t.sql).toBe('hasToken(email, {t0:String}) AND hasToken(email, {t1:String}) AND hasToken(email, {t2:String})')
  })

  test('only ASCII letters are folded, because ClickHouse lower() folds only those: other letters stay as they are', () => {
    expect(tokenClause('JÖRG').params).toEqual({ t0: 'jÖrg' })
  })

  test('a login with no word characters has no token clause (1 is always true), never an empty AND', () => {
    expect(tokenClause('___')).toEqual({ sql: '1', params: {} })
  })
})

function state(over: Partial<CandidateState> = {}): CandidateState {
  return { ...newCandidateState(), ...over }
}
const ctx = (over: Partial<{ distinctive: boolean; nHandle: number; anchored: boolean }> = {}) => ({ distinctive: true, nHandle: 5, anchored: true, ...over })

describe('confidenceOf (the rules the 2026-10-16 run was validated with)', () => {
  test('the same password as the login on the SAME site, shared by at most 2 logins, is high', () => {
    expect(confidenceOf(state({ pwSite: new Map([['a.test', 2]]) }), ctx())).toBe('high')
  })
  test('shared by 3 or 4 logins on that site it is medium, by 5 or more it is low', () => {
    expect(confidenceOf(state({ pwSite: new Map([['a.test', 3]]) }), ctx({ distinctive: false }))).toBe('medium')
    expect(confidenceOf(state({ pwSite: new Map([['a.test', 4]]) }), ctx({ distinctive: false }))).toBe('medium')
    expect(confidenceOf(state({ pwSite: new Map([['a.test', 5]]) }), ctx({ distinctive: false }))).toBe('low')
  })
  test('the account password on ANY site counts only when the account is pinned to a site (anchored)', () => {
    expect(confidenceOf(state({ pwGlobal: 2 }), ctx({ anchored: true }))).toBe('high')
    expect(confidenceOf(state({ pwGlobal: 2 }), ctx({ anchored: false, distinctive: false }))).toBe('low')
    expect(confidenceOf(state({ pwGlobal: 10 }), ctx({ anchored: true }))).toBe('medium')
    expect(confidenceOf(state({ pwGlobal: 11 }), ctx({ anchored: true, distinctive: false }))).toBe('low')
  })
  test('an address built from the handle that also uses one of the account passwords is high', () => {
    expect(confidenceOf(state({ observed: true, tiedSites: new Set(['a.test']) }), ctx({ distinctive: false }))).toBe('high')
  })
  test('a distinctive handle (few sites): the handle address plus a mail-provider sign-in is high', () => {
    expect(confidenceOf(state({ observed: true, provider: new Set(['accounts.google.com']) }), ctx({ distinctive: true }))).toBe('high')
  })
  test('a distinctive handle: the provider alone, a reused password on another site, or one of at most 3 handle addresses is medium', () => {
    expect(confidenceOf(state({ provider: new Set(['accounts.google.com']) }), ctx())).toBe('medium')
    expect(confidenceOf(state({ pwSiteOther: new Map([['b.test', 2]]) }), ctx())).toBe('medium')
    expect(confidenceOf(state({ observed: true }), ctx({ nHandle: 3 }))).toBe('medium')
  })
  test('a handle seen on many sites (not distinctive) never rises above low without a password link', () => {
    expect(confidenceOf(state({ observed: true, provider: new Set(['x']) }), ctx({ distinctive: false }))).toBe('low')
    expect(confidenceOf(state({ observed: true }), ctx({ nHandle: 4 }))).toBe('low')
  })
})

describe('associateLogin', () => {
  test('anchored on a site: the e-mail that shares the account password there is high, with the evidence and the queries in order', async () => {
    const { run, calls } = runnerOf((tag, _sql, p) => {
      if (tag === 'own') return [{ domain: 'example-site.test', password: PW }, { domain: 'other.test', password: 'x' }]
      if (tag === 'anchor') return [{ password: PW }]
      if (tag === 's1' && p.d === 'example-site.test') return [{ e: 'alice@mail.test', login_type: 'email' }, { e: 'alice2', login_type: 'username' }]
      if (tag === 's2') return [{ e: 'alice@mail.test', login_type: 'email', sites: '3' }]
      return []
    })
    const r = await associateLogin(item({ site: 'example-site.test' }), run)
    expect(r.anchored).toBe(true)
    expect(r.loginSites).toEqual(['example-site.test', 'other.test'])
    expect(r.candidates[0]).toMatchObject({ login: 'alice@mail.test', confidence: 'high' })
    expect(r.candidates[0].evidence).toContain('same password as the username on example-site.test (2 logins share it)')
    expect(r.candidates.map(c => c.login)).not.toContain('alice2') // a username is not an e-mail
    expect(calls.map(c => c.tag)).toEqual(['own', 'anchor', 's1', 's1', 's2', 'handle']) // no address with the handle exists, so there is nothing to tie to a password
  })

  test('the password given by the caller is a basis too: it pins the account even when the table has no row for that password', async () => {
    const { run, calls } = runnerOf((tag, _sql, p) => {
      if (tag === 's1') return p.p === 'PwFromTheList1' ? [{ e: 'bob@mail.test', login_type: 'email' }] : []
      return []
    })
    const r = await associateLogin(item({ login: 'bob_k', password: 'PwFromTheList1', site: 'example-site.test' }), run)
    expect(calls.some(c => c.tag === 's1' && c.params.d === 'example-site.test' && c.params.p === 'PwFromTheList1')).toBe(true)
    expect(calls.some(c => c.tag === 's2' && c.params.p === 'PwFromTheList1')).toBe(true)
    expect(r.anchored).toBe(true)
    expect(r.candidates[0]).toMatchObject({ login: 'bob@mail.test', confidence: 'high' })
  })

  test('a password shorter than 8 characters is never probed across sites', async () => {
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? [{ domain: 'example-site.test', password: 'short1' }] : []))
    await associateLogin(item({ site: 'example-site.test' }), run)
    expect(calls.filter(c => c.tag === 's2')).toHaveLength(0)
  })

  test('a password shared by 300 or more logins tells nothing: its logins are not candidates', async () => {
    const crowd = Array.from({ length: ASSOCIATE_LIMITS.popularityCap }, (_, i) => ({ e: `user${i}@mail.test`, login_type: 'email', sites: '1' }))
    const { run } = runnerOf((tag) => {
      if (tag === 'own') return [{ domain: 'example-site.test', password: PW }]
      if (tag === 's2') return crowd
      return []
    })
    const r = await associateLogin(item({ site: 'example-site.test' }), run)
    expect(r.candidates).toEqual([])
  })

  test('the reuse query runs under the popularity cap so a common password cannot scan the table', async () => {
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? [{ domain: 'example-site.test', password: PW }] : []))
    await associateLogin(item({ site: 'example-site.test' }), run)
    const s2 = calls.find(c => c.tag === 's2')!
    expect(s2.sql).toContain(`max_rows_to_group_by = ${ASSOCIATE_LIMITS.popularityCap}`)
    expect(s2.sql).toContain("group_by_overflow_mode = 'break'")
    expect(s2.sql).toContain('optimize_use_projections = 0')
    expect(s2.sql).toContain('lower(email) != lower({n:String})')
  })

  test('a handle with 500 address rows is too common to attribute', async () => {
    const many = Array.from({ length: ASSOCIATE_LIMITS.maxGroups }, (_, i) => ({ e: `alice_w@m${i}.test`, domain: `m${i}.test`, rows: '1' }))
    const { run } = runnerOf((tag) => (tag === 'handle' ? many : []))
    const r = await associateLogin(item(), run)
    expect(r.tooCommon).toBe(true)
  })

  test('an address with the handle as its local part is a candidate; one that also uses an account password is high', async () => {
    const { run } = runnerOf((tag) => {
      if (tag === 'own') return [{ domain: 'example-site.test', password: PW }]
      if (tag === 'handle') return [{ e: 'alice_w@mail.test', domain: 'mail.test', rows: '2' }]
      if (tag === 'tied') return [{ e: 'alice_w@mail.test', domain: 'mail.test' }]
      return []
    })
    const r = await associateLogin(item({ site: 'example-site.test' }), run)
    expect(r.candidates[0]).toMatchObject({ login: 'alice_w@mail.test', confidence: 'high' })
    expect(r.candidates[0].evidence).toContain('uses the handle and one of the account')
  })

  test('a sign-in page of a mail provider implies the address at that provider, even though no row shows it', async () => {
    const { run } = runnerOf((tag) => (tag === 'own' ? [{ domain: 'accounts.google.com', password: 'pw' }] : []))
    const r = await associateLogin(item({ login: 'carol_d' }), run)
    expect(r.candidates[0]).toMatchObject({ login: 'carol_d@gmail.com', confidence: 'medium' })
    expect(r.candidates[0].evidence).toContain('(address not seen in table)')
  })

  test('a query that fails is reported by kind without its text, and the other signals still count', async () => {
    const { run } = runnerOf((tag) => {
      if (tag === 'own') return [{ domain: 'example-site.test', password: PW }]
      if (tag === 's1') return [{ e: 'alice@mail.test', login_type: 'email' }]
      if (tag === 's2') return new Error(`Code: 159. DB::Exception: Timeout exceeded while reading ${PW}`)
      return []
    })
    const r = await associateLogin(item({ site: 'example-site.test' }), run)
    expect(r.errors).toEqual(['reuse: timed out'])
    expect(JSON.stringify(r)).not.toContain(PW)
    expect(r.candidates[0].login).toBe('alice@mail.test')
  })

  test('a failure of the first query is an answer with an error, never a throw', async () => {
    const { run } = runnerOf(() => new Error('connect ECONNREFUSED'))
    const r = await associateLogin(item(), run)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.candidates).toEqual([])
  })

  test('asking for usernames looks only at logins of that kind and never runs the e-mail-only signals', async () => {
    const { run, calls } = runnerOf((tag) => {
      if (tag === 'own') return [{ domain: 'accounts.google.com', password: PW }]
      if (tag === 's1') return [{ e: 'dave@mail.test', login_type: 'email' }, { e: 'dave_x', login_type: 'username' }]
      return []
    })
    const r = await associateLogin(item({ login: 'dave@mail.test', want: 'username' }), run)
    expect(r.candidates.map(c => c.login)).toEqual(['dave_x'])
    expect(calls.some(c => c.tag === 'handle' || c.tag === 'tied')).toBe(false)
  })

  test('every query is tagged, parameterised (no value is spliced into the text) and carries the exact-login predicate', async () => {
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? [{ domain: 'example-site.test', password: PW }] : []))
    await associateLogin(item({ login: "O'Brien\\x", site: 'example-site.test' }), run)
    for (const c of calls) {
      expect(c.tag).not.toBe('untagged')
      expect(c.sql).not.toContain('Brien')
      expect(c.sql).not.toContain(PW)
    }
    expect(calls[0].sql).toContain('lower(email) = lower({n:String})')
    expect(calls[0].params.n).toBe("O'Brien\\x")
  })

  test('the queries that read a login\'s own rows stop after the group cap, so a very common handle cannot scan the table to the 30 s limit', async () => {
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? [{ domain: 'example-site.test', password: PW }] : tag === 'handle' ? [{ e: 'alice_w@mail.test', domain: 'mail.test', rows: '1' }] : []))
    await associateLogin(item({ site: 'example-site.test' }), run)
    for (const tag of ['own', 'anchor', 'handle', 'tied']) {
      const c = calls.find(x => x.tag === tag)
      expect(c, tag).toBeDefined()
      expect(c!.sql, tag).toMatch(/max_rows_to_group_by = \d+/)
      expect(c!.sql, tag).toContain("group_by_overflow_mode = 'break'")
    }
    expect(calls.find(x => x.tag === 'own')!.sql).toContain(`max_rows_to_group_by = ${ASSOCIATE_LIMITS.maxGroups}`)
  })

  test('a login with no word to index is never run through the handle query: it would read the whole table', async () => {
    const { run, calls } = runnerOf(() => [])
    const r = await associateLogin(item({ login: '___' }), run)
    expect(calls.some(c => c.tag === 'handle' || c.tag === 'tied')).toBe(false)
    expect(r.errors).toEqual([])
  })

  test('a login that takes longer than its time budget stops being probed, and the answer says so', async () => {
    let clock = 0
    const { run, calls } = runnerOf((tag) => {
      clock += 25_000 // every query "takes" 25 s
      return tag === 'own' ? [{ domain: 'a.test', password: PW }, { domain: 'b.test', password: PW + '2' }, { domain: 'c.test', password: PW + '3' }] : []
    })
    const r = await associateLogin(item(), run, { now: () => clock, budgetMs: 60_000 })
    expect(calls.length).toBeLessThanOrEqual(4) // own, then queries until 60 s have passed
    expect(r.errors.some(e => e.includes('time budget'))).toBe(true)
    expect(r.errors.filter(e => e.includes('time budget'))).toHaveLength(1) // said once, not once per skipped query
  })

  test('at most 12 (site, password) pairs and 6 passwords are probed for one login', async () => {
    const own = Array.from({ length: 30 }, (_, i) => ({ domain: `s${i}.test`, password: `LongPassword${i}` }))
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? own : []))
    await associateLogin(item(), run)
    expect(calls.filter(c => c.tag === 's1').length).toBeLessThanOrEqual(ASSOCIATE_LIMITS.maxPairs)
    expect(calls.filter(c => c.tag === 's2').length).toBeLessThanOrEqual(ASSOCIATE_LIMITS.maxPasswords)
  })
})

describe('parsePasswordLookup / buildPasswordLookupSql / lookupPassword', () => {
  test('the defaults: e-mail logins, 100 results, no site filter', () => {
    expect(parsePasswordLookup({ password: PW })).toEqual({ ok: true, lookup: { password: PW, type: 'email', limit: 100 } })
  })

  test('type, limit and site are validated', () => {
    expect(parsePasswordLookup({ password: PW, type: 'any', limit: 5, domain: 'WWW.Example-Site.test' })).toEqual({
      ok: true,
      lookup: { password: PW, type: 'any', limit: 5, domain: 'example-site.test' },
    })
    for (const bad of [{}, { password: '' }, { password: 5 }, { password: 'x'.repeat(PASSWORD_LOOKUP_LIMITS.maxPasswordLength + 1) },
      { password: PW, type: 'fax' }, { password: PW, limit: 0 }, { password: PW, limit: PASSWORD_LOOKUP_LIMITS.maxLimit + 1 }, { password: PW, limit: 1.5 },
      { password: PW, domain: 'http://x.test' }]) {
      expect(parsePasswordLookup(bad).ok).toBe(false)
    }
  })

  test('the SQL matches the password exactly, reads at most a capped number of rows, groups by login, and carries no value in its text', () => {
    const { sql, params, scanCap } = buildPasswordLookupSql({ password: PW, type: 'email', limit: 100, domain: 'example-site.test' })
    expect(sql).toContain('password = {p:String}')
    expect(sql).toContain('login_type = {t:String}')
    expect(sql).toContain('domain = {d:String}')
    expect(sql).toContain('LIMIT {scan:UInt32}') // the scan stops after that many matching rows, however common the password is
    expect(sql).toContain('GROUP BY login')
    expect(sql).toContain('LIMIT {lim:UInt32}')
    expect(sql).toContain('sum(rows) OVER () AS scanned')
    expect(sql).toContain('optimize_use_projections = 0')
    expect(sql).not.toContain(PW)
    expect(params).toEqual({ p: PW, t: 'email', d: 'example-site.test', scan: scanCap, lim: 101 })
  })

  test('type any adds no login_type filter and no site filter adds no domain filter', () => {
    const { sql, params } = buildPasswordLookupSql({ password: PW, type: 'any', limit: 10 })
    expect(sql).not.toContain('login_type = {t:String}')
    expect(sql).not.toContain('domain = {d:String}')
    expect(params).toMatchObject({ p: PW, lim: 11 })
    expect(Object.keys(params).sort()).toEqual(['lim', 'p', 'scan'])
  })

  test('the result is trimmed to the limit and says whether there were more; a scan that hit its cap says the answer is partial', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ login: `u${i}@m.test`, login_type: 'email', sites: String(4 - i), domains: ['a.test'], rows: '1', scanned: '4' }))
    const out = await lookupPassword({ password: PW, type: 'email', limit: 3 }, async () => rows)
    expect(out.results).toHaveLength(3)
    expect(out.hasMore).toBe(true)
    expect(out.partial).toBe(false)
    expect(out.results[0]).toEqual({ login: 'u0@m.test', loginType: 'email', sites: 4, domains: ['a.test'], rows: 1 })

    const { scanCap } = buildPasswordLookupSql({ password: PW, type: 'email', limit: 3 })
    const crowd = rows.map(r => ({ ...r, scanned: String(scanCap) }))
    const partial = await lookupPassword({ password: PW, type: 'email', limit: 3 }, async () => crowd)
    expect(partial.partial).toBe(true)
  })

  test('no rows is an empty answer, not a failure', async () => {
    const out = await lookupPassword({ password: PW, type: 'email', limit: 3 }, async () => [])
    expect(out).toEqual({ results: [], partial: false, hasMore: false })
  })
})

// ── the imported window (docs/superpowers/specs/2026-10-18-imported-window-ux-design.md) ─────────────────────────────────────────────

const AFTER = Date.UTC(2026, 9, 5, 14, 37, 0) / 1000 // 2026-10-05T14:37:00Z
const WINDOW = { lower: AFTER, upper: null }
const WINDOW_BOTH = { lower: AFTER, upper: AFTER + 3600 }

describe('password lookup: imported_after / imported_before', () => {
  test('the bounds are read like every other v1 route reads them (same parser, same messages); an empty value is no bound', () => {
    const r = parsePasswordLookup({ password: PW, imported_after: '2026-10-05T14:37:00Z', imported_before: '2026-10-06' })
    expect(r).toEqual({ ok: true, lookup: { password: PW, type: 'email', limit: 100, range: { lower: AFTER, upper: Date.UTC(2026, 9, 6) / 1000 + 86_399 } } })
    expect(parsePasswordLookup({ password: PW, imported_after: '', imported_before: null })).toEqual({ ok: true, lookup: { password: PW, type: 'email', limit: 100 } })
    for (const [field, value] of [['imported_after', 'yesterday'], ['imported_before', '2026-02-30'], ['imported_after', 5]] as const) {
      const bad = parsePasswordLookup({ password: PW, [field]: value })
      expect(bad.ok).toBe(false)
      expect(bad.ok === false && bad.error).toContain(`${field} must be`)
    }
  })

  test('the window is a plain predicate on imported_at in the same WHERE as the password, with its own parameters; the text still carries no value', () => {
    const { sql, params } = buildPasswordLookupSql({ password: PW, type: 'email', limit: 10, domain: 'example-site.test', range: WINDOW_BOTH })
    expect(sql).toContain('password = {p:String} AND login_type = {t:String} AND domain = {d:String} AND imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})')
    expect(params).toMatchObject({ p: PW, t: 'email', d: 'example-site.test', impAfter: AFTER, impBefore: AFTER + 3600 })
    expect(sql).not.toContain(String(AFTER))
    const lowerOnly = buildPasswordLookupSql({ password: PW, type: 'any', limit: 10, range: WINDOW })
    expect(lowerOnly.sql).toContain('imported_at > toDateTime({impAfter:Int64})')
    expect(lowerOnly.sql).not.toContain('impBefore')
  })

  test('without a window the SQL is exactly what it was', () => {
    const { sql, params } = buildPasswordLookupSql({ password: PW, type: 'email', limit: 100 })
    expect(sql).not.toContain('imported_at')
    expect(Object.keys(params).sort()).toEqual(['lim', 'p', 'scan', 't'])
  })
})

describe('associateLogin with a window: it limits where a candidate can come from, nothing else', () => {
  const win = (rows: Row[]) => rows
  const OWN = [{ domain: 'example-site.test', password: PW }]

  test('without a window no query mentions the window, and a candidate needs no flag', async () => {
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? OWN : tag === 's1' ? [{ e: 'alice@mail.test', login_type: 'email' }] : []))
    const r = await associateLogin(item({ site: 'example-site.test' }), run)
    expect(r.candidates.map(c => c.login)).toEqual(['alice@mail.test'])
    for (const c of calls) {
      expect(c.sql).not.toContain('in_win')
      expect(Object.keys(c.params)).not.toContain('impAfter')
    }
  })

  test('the login\'s own rows and its anchor are read from the whole table: they are what identifies the account', async () => {
    const { run, calls } = runnerOf((tag) => (tag === 'own' ? OWN : tag === 'anchor' ? [{ password: PW }] : []))
    await associateLogin(item({ site: 'example-site.test' }), run, { range: WINDOW })
    for (const tag of ['own', 'anchor']) {
      const c = calls.find(x => x.tag === tag)!
      expect(c.sql, tag).not.toContain('imported_at')
      expect(Object.keys(c.params), tag).not.toContain('impAfter')
    }
  })

  test('every candidate-producing query returns whether the group has a row in the window, with the bounds as parameters', async () => {
    const { run, calls } = runnerOf((tag, _sql, p) => {
      if (tag === 'own') return [{ domain: 'example-site.test', password: PW }]
      if (tag === 's1') return [{ e: 'alice@mail.test', login_type: 'email', in_win: 1 }]
      if (tag === 'handle') return [{ e: 'alice@mail.test', domain: 'example-site.test', rows: '2', in_win: 1 }]
      void p
      return []
    })
    await associateLogin(item({ login: 'alice', site: 'example-site.test' }), run, { range: WINDOW_BOTH })
    const tags = new Set(calls.map(c => c.tag))
    for (const tag of ['s1', 's2', 'handle', 'tied']) expect(tags.has(tag), tag).toBe(true)
    for (const c of calls.filter(x => ['s1', 's2', 'handle', 'tied'].includes(x.tag))) {
      expect(c.sql, c.tag).toContain('max(imported_at > toDateTime({impAfter:Int64}) AND imported_at <= toDateTime({impBefore:Int64})) AS in_win')
      expect(c.params, c.tag).toMatchObject({ impAfter: AFTER, impBefore: AFTER + 3600 })
    }
  })

  test('a candidate whose rows are all outside the window is not returned; one with a row inside is', async () => {
    const { run } = runnerOf((tag) => {
      if (tag === 'own') return OWN
      if (tag === 's1') return win([{ e: 'old@mail.test', login_type: 'email', in_win: 0 }, { e: 'new@mail.test', login_type: 'email', in_win: 1 }])
      return []
    })
    const r = await associateLogin(item({ site: 'example-site.test' }), run, { range: WINDOW })
    expect(r.candidates.map(c => c.login)).toEqual(['new@mail.test'])
    expect(r.candidatesTotal).toBe(1)
  })

  test('how many logins share a password is counted over the WHOLE table, so a narrow window cannot make a common password look rare', async () => {
    // 300 logins use the password (the popularity cap); only two of them have a row in the window.
    const crowd = Array.from({ length: ASSOCIATE_LIMITS.popularityCap }, (_, i) => ({ e: `u${i}@m.test`, login_type: 'email', sites: '1', in_win: i < 2 ? 1 : 0 }))
    const { run } = runnerOf((tag) => (tag === 'own' ? OWN : tag === 's2' ? crowd : []))
    const r = await associateLogin(item({ site: 'example-site.test' }), run, { range: WINDOW })
    expect(r.candidates).toEqual([])
  })

  test('the evidence still says how many logins share the password, windowed or not', async () => {
    const others = [
      { e: 'new@mail.test', login_type: 'email', in_win: 1 },
      ...Array.from({ length: 4 }, (_, i) => ({ e: `old${i}@mail.test`, login_type: 'email', in_win: 0 })),
    ]
    const { run } = runnerOf((tag) => (tag === 'own' ? OWN : tag === 's1' ? others : []))
    const r = await associateLogin(item({ site: 'example-site.test' }), run, { range: WINDOW })
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].evidence).toContain('(5 logins share it)')
  })

  test('an address implied only by a mail provider sign-in is not "in the window": no row of it was added', async () => {
    const own = [{ domain: 'accounts.google.com', password: PW }]
    const unwindowed = runnerOf((tag) => (tag === 'own' ? own : []))
    const without = await associateLogin(item({ login: 'alice' }), unwindowed.run)
    expect(without.candidates.map(c => c.login)).toEqual(['alice@gmail.com'])

    const windowed = runnerOf((tag) => (tag === 'own' ? own : []))
    const withWin = await associateLogin(item({ login: 'alice' }), windowed.run, { range: WINDOW })
    expect(withWin.candidates).toEqual([])
  })

  test('how many addresses share the handle is also counted over the whole table, so confidence does not rise because the window is narrow', async () => {
    const own = [{ domain: 'accounts.google.com', password: PW }]
    const five = (inWin: (i: number) => number): Row[] =>
      Array.from({ length: 5 }, (_, i) => ({ e: `alice@m${i}.test`, domain: 'site.test', rows: '1', in_win: inWin(i) }))
    // one address of five has a row in the window: with the unwindowed count (5 > 3) it stays low; counted inside the window it would be "one of at most 3", medium
    const { run } = runnerOf((tag) => (tag === 'own' ? own : tag === 'handle' ? five(i => (i === 0 ? 1 : 0)) : []))
    const r = await associateLogin(item({ login: 'alice' }), run, { range: WINDOW })
    expect(r.candidates.map(c => [c.login, c.confidence])).toEqual([['alice@m0.test', 'low']])
  })
})

describe('associateLogin: the tied-address rows', () => {
  const own = [{ domain: 'accounts.google.com', password: PW }]

  test('without a window an address that only the tied query returned (the handle list was cut short) is still a candidate, as it always was', async () => {
    const { run } = runnerOf((tag) => {
      if (tag === 'own') return own
      if (tag === 'handle') return [{ e: 'alice@m0.test', domain: 'site.test', rows: '1' }]
      if (tag === 'tied') return [{ e: 'alice@m9.test', domain: 'site.test' }]
      return []
    })
    const r = await associateLogin(item({ login: 'alice' }), run)
    expect(r.candidates.map(c => c.login)).toContain('alice@m9.test')
  })

  test('with a window an address qualifies through its own in-window tied row, even when the handle list did not list it', async () => {
    const { run } = runnerOf((tag) => {
      if (tag === 'own') return own
      if (tag === 'handle') return [{ e: 'alice@m0.test', domain: 'site.test', rows: '1', in_win: 0 }]
      if (tag === 'tied') return [{ e: 'alice@m9.test', domain: 'site.test', in_win: 1 }, { e: 'alice@m8.test', domain: 'site.test', in_win: 0 }]
      return []
    })
    const r = await associateLogin(item({ login: 'alice' }), run, { range: WINDOW })
    expect(r.candidates.map(c => c.login)).toEqual(['alice@m9.test'])
  })
})
