import { describe, test, expect, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ executeQuery: vi.fn(), getClient: vi.fn() }))

import {
  buildDictionaryRowsSql, buildDictionaryTotalsSql, wordTextBranch, DICTIONARY_SQL_MAX_CHARS, type DictionaryCandidates,
} from '@/lib/search-dictionary-plan'
import { buildULPWhere, parseULPQuery, wordLeaves } from '@/lib/ulp-search'

const LEAVES = wordLeaves('tok0')
const NOT_LEAVES = ` AND NOT (${LEAVES})`
const QCLAUSE = buildULPWhere(parseULPQuery('ledger')).clause
const WHERE = `1=1 AND (${QCLAUSE}) AND is_noise = 0`
const WHERE_T = `1=1 AND (${LEAVES}) AND is_noise = 0`
const WHERE_RAW = `1=1 AND (${QCLAUSE})`
const WHERE_RAW_T = `1=1 AND (${LEAVES})`
const CURSOR = ' AND (domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})'
const DOMAIN_ORDER = 'domain ASC,  email ASC, imported_at ASC, url ASC, password ASC'
const EMAIL_ORDER = 'email ASC, domain ASC, imported_at ASC, url ASC, password ASC'
const OFFSET = "(_part, _part_offset) IN (SELECT _part, _part_offset FROM ulp.credentials WHERE reverse(email_domain) IN ['moc.regdel'] SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')"
const D = "['ledger.com','app.ledger.com']"
const cands = (over: Partial<DictionaryCandidates> = {}): DictionaryCandidates => ({
  domains: ['ledger.com', 'app.ledger.com'], emailDomains: ['ledger.com'], empty: false, domainsLiteral: D, emailRevLiteral: "['moc.regdel']", ...over,
})
const NO_D = { domains: [], domainsLiteral: '[]' }
const NO_E = { emailDomains: [], emailRevLiteral: '[]' }
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

const rowsInput = (over: Record<string, unknown> = {}) => ({
  where: WHERE, cursorClause: CURSOR, orderBy: DOMAIN_ORDER, dedupe: true, dedupeInWindow: false,
  rawCols: 'url, email, password, domain, imported_at', selectList: 'NORMALIZED, url AS _c_url',
  sortMaxMemoryBytes: 4_294_967_296, normColsSetting: 'prefer_column_name_to_alias = 1',
  candidates: cands(), text: wordTextBranch(WHERE, QCLAUSE)!, maxSeconds: 4, ...over,
})
const totalsInput = (over: Record<string, unknown> = {}) => ({
  whereRaw: WHERE_RAW, dedupe: true, hasUserFilter: true, onlyIf: 'is_noise = 0',
  candidates: cands(), text: wordTextBranch(WHERE_RAW, QCLAUSE)!, maxSeconds: 12, overflow: 'throw' as const, ...over,
})

describe('buildDictionaryRowsSql for a word', () => {
  test('three disjoint branches: H and E over the UNCHANGED WHERE and keyset clause with the exclusion, T over the WHERE with the leaves alone', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(sql.split(`WHERE ${WHERE}${CURSOR}`).length - 1).toBe(2) // H and E, verbatim
    expect(sql.split(`WHERE ${WHERE_T}${CURSOR}`).length - 1).toBe(1) // T
    expect(sql).toContain(`${CURSOR} AND domain IN ${D}${NOT_LEAVES}\nORDER BY`)
    expect(sql).toContain(`${CURSOR} AND domain NOT IN ${D}${NOT_LEAVES} AND ${OFFSET}\nORDER BY`)
    expect(count(sql, /UNION ALL/g)).toBe(2)
    const t = sql.split('UNION ALL').find(b => b.includes(`WHERE ${WHERE_T}`))!
    expect(t).not.toContain('url_host LIKE')
    expect(t).not.toContain('NOT (')
    expect(t).not.toContain('domain IN')
  })

  test('the settings: projections off on T and H (the branch), the PREWHERE guards on E only, projections never off on E or on the outer query', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /optimize_use_projections = 0/g)).toBe(2)
    expect(count(sql, /optimize_move_to_prewhere = 0/g)).toBe(1)
    expect(count(sql, /query_plan_optimize_lazy_materialization = 0/g)).toBe(1)
    const branches = sql.split('UNION ALL')
    const [h, e, t] = [branches[0], branches[1], branches[2]]
    expect(h).toContain('LIMIT {limit:UInt32} SETTINGS optimize_use_projections = 0')
    expect(e).toContain('LIMIT {limit:UInt32} SETTINGS optimize_move_to_prewhere = 0, query_plan_optimize_lazy_materialization = 0')
    expect(e).not.toContain('optimize_use_projections = 0')
    expect(t).toContain('SETTINGS optimize_use_projections = 0')
    expect(sql).toContain("SETTINGS optimize_use_projections = 1, preferred_optimize_projection_name = 'proj_email_domain_rev')")
    expect(sql.slice(sql.lastIndexOf(') AS t'))).not.toContain('optimize_use_projections')
  })

  test('the plan\'s own time limit goes to the outer query; without one it is today\'s 300 s', () => {
    expect(buildDictionaryRowsSql(rowsInput())!).toMatch(/\) AS t\s+SETTINGS max_execution_time = 4,\s+timeout_overflow_mode = 'throw',\s+http_wait_end_of_query = 1,/)
    expect(buildDictionaryRowsSql(rowsInput({ maxSeconds: undefined }))!).toMatch(/\) AS t\s+SETTINGS max_execution_time = 300,/)
  })

  test('a domain-led sort de-duplicates inside each branch, then again in the merge', () => {
    const sql = buildDictionaryRowsSql(rowsInput())!
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(4)
    expect(count(sql, /LIMIT \{limit:UInt32\}/g)).toBe(4)
    expect(sql).not.toContain('windowLimit')
  })

  test('Unique with a sort not led by domain keeps the legacy window in all three branches and in the cut of the union', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ orderBy: EMAIL_ORDER, dedupeInWindow: true }))!
    expect(count(sql, /LIMIT \{windowLimit:UInt32\}/g)).toBe(4)
    expect(count(sql, /LIMIT 1 BY content_key_hash/g)).toBe(1)
  })

  test('without Unique nothing is de-duplicated anywhere', () => {
    expect(buildDictionaryRowsSql(rowsInput({ dedupe: false }))!).not.toContain('LIMIT 1 BY')
  })

  test('only host candidates: H and T. Only e-mail candidates: E (no domain predicate) and T. Neither: T alone.', () => {
    const onlyD = buildDictionaryRowsSql(rowsInput({ candidates: cands({ ...NO_E }) }))!
    expect(count(onlyD, /UNION ALL/g)).toBe(1)
    expect(onlyD).not.toContain('_part_offset')
    expect(onlyD).not.toContain('NOT IN')
    expect(onlyD).toContain(`AND domain IN ${D}${NOT_LEAVES}`)

    const onlyE = buildDictionaryRowsSql(rowsInput({ candidates: cands({ ...NO_D }) }))!
    expect(count(onlyE, /UNION ALL/g)).toBe(1)
    expect(onlyE).not.toMatch(/domain (NOT )?IN \[/)
    expect(onlyE).toContain(`${CURSOR}${NOT_LEAVES} AND ${OFFSET}`)

    const none = buildDictionaryRowsSql(rowsInput({ candidates: cands({ ...NO_D, ...NO_E, empty: true }) }))!
    expect(none).not.toContain('UNION ALL')
    expect(none).not.toContain('_part_offset')
    expect(none).not.toContain('NOT (')
    expect(none).toContain(`WHERE ${WHERE_T}${CURSOR}`)
    expect(none).toContain('SETTINGS optimize_use_projections = 0')
  })

  test('null when the search was not replaced (T would repeat the other branches), or the SQL would not fit max_query_size', () => {
    expect(buildDictionaryRowsSql(rowsInput({ text: { where: WHERE, exclude: NOT_LEAVES } }))).toBeNull()
    const huge = `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS / 2)}']`
    expect(buildDictionaryRowsSql(rowsInput({ candidates: cands({ domainsLiteral: huge }) }))).toBeNull()
  })

  test('the only placeholders are the route\'s own, plus the word\'s two', () => {
    const names = new Set([...buildDictionaryRowsSql(rowsInput())!.matchAll(/\{(\w+):/g)].map(m => m[1]))
    expect([...names].sort()).toEqual(['c_d', 'c_e', 'c_ia', 'c_pw', 'c_u', 'limit', 'tlk0', 'tok0'].sort())
  })

  test('a domain term (no text branch) gets exactly the SQL it always got', () => {
    const sql = buildDictionaryRowsSql(rowsInput({ text: undefined, maxSeconds: undefined, where: '1=1 AND ((domain = {dom0:String} OR url_host LIKE {domlk0:String}))' }))!
    expect(sql).not.toContain('NOT (')
    expect(sql).not.toContain('optimize_use_projections = 0')
    expect(count(sql, /UNION ALL/g)).toBe(1)
    expect(sql).toMatch(/\) AS t\s+SETTINGS max_execution_time = 300,/)
  })
})

describe('buildDictionaryTotalsSql for a word', () => {
  test('one aggregate per branch, combined by merging states, the leaves-only WHERE for T and the exclusion for H and E', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toContain('SELECT uniqIfMerge(part_total) AS total, sum(part_rows) AS raw_total')
    expect(count(sql, /uniqIfState\(content_key_hash, is_noise = 0\) AS part_total, count\(\) AS part_rows/g)).toBe(3)
    expect(count(sql, /UNION ALL/g)).toBe(2)
    expect(sql).toContain(`WHERE ${WHERE_RAW} AND domain IN ${D}${NOT_LEAVES} SETTINGS optimize_use_projections = 0`)
    expect(sql).toContain(`WHERE ${WHERE_RAW} AND domain NOT IN ${D}${NOT_LEAVES} AND ${OFFSET} SETTINGS optimize_move_to_prewhere = 0`)
    expect(sql).toContain(`WHERE ${WHERE_RAW_T} SETTINGS optimize_use_projections = 0`)
    expect(sql).not.toContain('{c_d') // no keyset clause
  })

  test('the budget throws on an overrun (the caller then runs today\'s count); the default is today\'s partial count after 300 s', () => {
    expect(buildDictionaryTotalsSql(totalsInput())!)
      .toMatch(/SETTINGS optimize_trivial_count_query = 1,\s+max_execution_time = 12,\s+timeout_overflow_mode = 'throw',\s+use_query_cache = 0$/)
    expect(buildDictionaryTotalsSql(totalsInput({ maxSeconds: undefined, overflow: undefined }))!)
      .toMatch(/SETTINGS optimize_trivial_count_query = 1,\s+max_execution_time = 300,\s+timeout_overflow_mode = 'break',\s+use_query_cache = 0$/)
  })

  test('neither list: T alone, a single aggregate; the wrong WHERE or an oversize list: null', () => {
    const sql = buildDictionaryTotalsSql(totalsInput({ candidates: cands({ ...NO_D, ...NO_E, empty: true }) }))!
    expect(sql).not.toContain('UNION ALL')
    expect(count(sql, /uniqIfState/g)).toBe(1)
    expect(buildDictionaryTotalsSql(totalsInput({ text: { where: WHERE_RAW, exclude: NOT_LEAVES } }))).toBeNull()
    expect(buildDictionaryTotalsSql(totalsInput({ candidates: cands({ domainsLiteral: `['${'a'.repeat(DICTIONARY_SQL_MAX_CHARS)}']` }) }))).toBeNull()
  })

  test('is recognised by the older route tests as a totals query, and never as a data query', () => {
    const sql = buildDictionaryTotalsSql(totalsInput())!
    expect(sql).toMatch(/AS raw_total/)
    expect(sql).not.toMatch(/\) AS t\s/)
  })
})
