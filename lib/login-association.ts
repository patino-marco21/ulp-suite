/**
 * Which other logins belong to the same account as a given login, and which logins use a given password.
 * Design and measurements: docs/superpowers/specs/2026-10-18-login-association-design.md.
 *
 * `ulp.credentials.email` is the login as typed (an e-mail address, a bare username or a phone number: `login_type` says which), and a ULP line never
 * pairs a username with an e-mail address. So an association is INFERRED from other rows, and the strongest link is the account's own password: the
 * password a login has on a site identifies the person better than the handle does (a generic handle belongs to many people). Signals, strongest first:
 *
 *   S1 site     a login of the wanted kind on the SAME site with the SAME password
 *   S2 reuse    a login of the wanted kind on ANY site with that same (non-trivial) password; the fewer logins share the password, the stronger
 *   S3 handle   (e-mail wanted) an address whose local part equals the handle; strong only if it also uses one of the account's passwords
 *   S4 provider (e-mail wanted) the login signs in at a mail provider (accounts.google.com ...), which implies <handle>@<provider>
 *
 * The rules and thresholds are the ones the 2026-10-16 run was validated with (32 high, 28 medium, 53 low, 9 none on 122 handles; random pairings share
 * four or more letters 0.3% of the time against 41-54% for high/medium). They are heuristics, not proof: `confidence` says how strong the evidence is,
 * `evidence` says what it is. Every query is read-only, tagged `/* assoc:<step> *\/` (so system.query_log shows which step cost what), parameterised
 * (no login, site or password is spliced into the SQL text) and capped. Nothing here logs or returns a password.
 *
 * The runner is injected: the routes pass lib/clickhouse's executeQuery, the tests pass a fake.
 *
 * Imported window (imported_after / imported_before, lib/imported-range.ts; design 2026-10-18-imported-window-ux-design.md). For the password lookup it is
 * a WHERE predicate: the logins that use the password among the rows added in the window. For an association it limits where a CANDIDATE can come
 * from: the login's own rows and its anchor on a site are always read from the whole table (they are what identifies the account), every query that
 * produces candidates also returns `max(<window>) AS in_win`, and a candidate qualifies only when a row that produced it is in the window. The
 * popularity gates (a password shared by 300+ logins, a handle on many addresses) keep counting the whole table, so a narrow window cannot make a
 * common password or handle look rare.
 */
import { addressEquals } from '@/lib/address-lookup'
import { isConnectionError } from '@/lib/clickhouse-migration-safety'
import { hasImportedRange, importedRangePlain, parseImportedRange, type ImportedRange } from '@/lib/imported-range'

export type WantedLogin = 'email' | 'username' | 'phone'
export type Confidence = 'high' | 'medium' | 'low'
const WANTED: readonly WantedLogin[] = ['email', 'username', 'phone']

export const ASSOCIATE_LIMITS = {
  /** Logins per request: one login costs a few seconds of ClickHouse time. */
  maxItems: 10,
  maxLoginLength: 256,
  maxPasswordLength: 256,
  /** A shorter password is never evidence across sites. */
  minReusePasswordLength: 8,
  /** A password shared by this many logins or more tells nothing about one account. */
  popularityCap: 300,
  /** Rows read by one handle or own-rows query; reaching it marks the handle "too common". */
  maxGroups: 500,
  /** (site, password) pairs probed per login. */
  maxPairs: 12,
  /** Passwords probed for cross-site reuse per login. */
  maxPasswords: 6,
  /** A handle seen on more sites than this is probably several people. */
  distinctiveSites: 5,
  /** Candidates returned per login (all are ranked, `candidatesTotal` says how many there were). */
  maxCandidates: 10,
  /** Word tokens of the login used to prune with the text index. */
  maxTokens: 6,
  /** Rows an anchor query may group before it stops. */
  maxAnchorGroups: 50,
  /** Wall-clock budget for one login; queries after it are skipped and the answer says so. */
  itemBudgetMs: 40_000,
} as const

export interface AssociateItem {
  login: string
  want: WantedLogin
  /** A password the account is known to use (optional). With `site` it pins the account; alone it is still probed for reuse. */
  password?: string
  /** The site the login is known from (optional): the account's password THERE identifies the person. */
  site?: string
}

export interface Candidate {
  login: string
  confidence: Confidence
  evidence: string
}

export interface AssociateResult {
  login: string
  want: WantedLogin
  /** The account is pinned to a site (given, or one of the stored rows of the login), so reuse on other sites counts. */
  anchored: boolean
  /** The handle matched too many rows to attribute to one person. */
  tooCommon: boolean
  loginSites: string[]
  candidatesTotal: number
  candidates: Candidate[]
  /** Steps that failed, by kind and never with the query text: `reuse: timed out`. */
  errors: string[]
}

type Row = Record<string, unknown>
export type QueryRunner = (sql: string, params: Record<string, unknown>) => Promise<Row[]>

const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())
const HOST = /^[a-z0-9._-]{1,253}$/
const CONTROL = /[\u0000-\u001f\u007f]/

/** A site as the `domain` column stores it: lowercase, no leading www. Null when it is not a bare host name. */
function normalizeSite(raw: string): string | null {
  const host = asciiLower(raw.trim()).replace(/^www\./, '')
  return HOST.test(host) ? host : null
}

export function parseAssociateItem(raw: unknown): { ok: true; item: AssociateItem } | { ok: false; error: string } {
  const L = ASSOCIATE_LIMITS
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'each item must be an object with a login' }
  const o = raw as Record<string, unknown>
  if (typeof o.login !== 'string') return { ok: false, error: 'login is required and must be a string' }
  const login = o.login.trim()
  if (login === '') return { ok: false, error: 'login must not be empty' }
  if (login.length > L.maxLoginLength) return { ok: false, error: `login is longer than ${L.maxLoginLength} characters` }
  if (CONTROL.test(login)) return { ok: false, error: 'login must not contain control characters' }

  const item: AssociateItem = { login, want: 'email' }
  if (o.want !== undefined && o.want !== null) {
    if (typeof o.want !== 'string' || !WANTED.includes(o.want as WantedLogin)) return { ok: false, error: `want must be one of ${WANTED.join(', ')}` }
    item.want = o.want as WantedLogin
  }
  if (o.password !== undefined && o.password !== null && o.password !== '') {
    if (typeof o.password !== 'string') return { ok: false, error: 'password must be a string' }
    if (o.password.length > L.maxPasswordLength) return { ok: false, error: `password is longer than ${L.maxPasswordLength} characters` }
    item.password = o.password
  }
  if (o.site !== undefined && o.site !== null && o.site !== '') {
    if (typeof o.site !== 'string') return { ok: false, error: 'site must be a string' }
    const site = normalizeSite(o.site)
    if (!site) return { ok: false, error: 'site must be a bare host name such as example.com' }
    item.site = site
  }
  return { ok: true, item }
}

/**
 * `hasToken(email, word)` for each word of the login, so the text index prunes before the exact comparison runs. Words are cut like the index cuts them
 * (ASCII non-alphanumerics separate, every other character belongs to a word) and lowercased the way ClickHouse's lower() does (ASCII only).
 */
export function tokenClause(login: string): { sql: string; params: Record<string, string> } {
  const words = [...new Set(asciiLower(login).match(/[a-z0-9\u0080-￿]+/g) ?? [])].slice(0, ASSOCIATE_LIMITS.maxTokens)
  if (words.length === 0) return { sql: '1', params: {} }
  const params: Record<string, string> = {}
  words.forEach((w, i) => { params[`t${i}`] = w })
  return { sql: words.map((_, i) => `hasToken(email, {t${i}:String})`).join(' AND '), params }
}

// What each probed candidate has accumulated.
export interface CandidateState {
  /** An address with the handle as its local part exists in the table. */
  observed: boolean
  handleRows: number
  handleSites: Set<string>
  /** Sites where that address also uses one of the account's passwords. */
  tiedSites: Set<string>
  /** Site -> logins sharing the ACCOUNT's password there (the candidate included): the account is pinned to this site. */
  pwSite: Map<string, number>
  /** The same for the login's rows on OTHER sites, which may belong to someone else with the same handle. */
  pwSiteOther: Map<string, number>
  /** Logins sharing the account's password anywhere (the candidate included). */
  pwGlobal: number | null
  pwGlobalSites: number
  /** Sign-in hosts that imply this address. */
  provider: Set<string>
  /** With an imported window: a row that produced this candidate was added in the window. Unset without one. */
  inWindow?: boolean
}

export function newCandidateState(): CandidateState {
  return { observed: false, handleRows: 0, handleSites: new Set(), tiedSites: new Set(), pwSite: new Map(), pwSiteOther: new Map(), pwGlobal: null, pwGlobalSites: 0, provider: new Set() }
}

const minOf = (m: Map<string, number>) => (m.size === 0 ? 99 : Math.min(...m.values()))

export function confidenceOf(c: CandidateState, ctx: { distinctive: boolean; nHandle: number; anchored: boolean }): Confidence {
  const site = minOf(c.pwSite)
  const other = minOf(c.pwSiteOther)
  const glob = c.pwGlobal !== null && ctx.anchored ? c.pwGlobal : 99
  if (site <= 2 || glob <= 2 || (c.observed && c.tiedSites.size > 0)) return 'high'
  if (site <= 4 || glob <= 10) return 'medium'
  if (ctx.distinctive && c.observed && c.provider.size > 0) return 'high'
  if (ctx.distinctive && (other <= 2 || c.provider.size > 0 || (c.observed && ctx.nHandle <= 3))) return 'medium'
  return 'low'
}

function evidenceOf(c: CandidateState, anchorSite: string | undefined, anchored: boolean): string {
  const out: string[] = []
  const best = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]
  if (c.pwSite.size > 0) {
    const [s, n] = best(c.pwSite)
    out.push(`same password as the username on ${s} (${n} logins share it)`)
  }
  if (c.pwGlobal !== null && c.pwSite.size === 0) {
    const what = anchored ? `the username's ${anchorSite ?? 'known'} login` : "one of the username's logins"
    out.push(`same password as ${what}, on ${c.pwGlobalSites} site(s) (${c.pwGlobal} logins share it)`)
  }
  if (c.pwSiteOther.size > 0 && c.pwSite.size === 0) {
    const [s, n] = best(c.pwSiteOther)
    out.push(`same password as the username's row on ${s} (${n} logins share it); that row may be another person`)
  }
  if (c.observed && c.tiedSites.size > 0) out.push("uses the handle and one of the account's passwords")
  else if (c.observed) out.push(`same handle only (${c.handleRows} rows, ${c.handleSites.size} sites; may be another person)`)
  if (c.provider.size > 0) out.push(`username signs in at ${[...c.provider].sort().join(', ')}${c.observed ? '' : ' (address not seen in table)'}`)
  return out.join('; ')
}

const PROVIDERS: Record<string, string[]> = {
  'accounts.google.com': ['gmail.com'], 'gmail.com': ['gmail.com'], 'mail.google.com': ['gmail.com'],
  'remotedesktop.google.com': ['gmail.com'], 'workspace.google.com': ['gmail.com'],
  'login.live.com': ['outlook.com', 'hotmail.com', 'live.com'], 'account.live.com': ['outlook.com', 'hotmail.com', 'live.com'],
  'outlook.live.com': ['outlook.com', 'hotmail.com', 'live.com'],
  'login.yahoo.com': ['yahoo.com'], 'mail.yahoo.com': ['yahoo.com'],
  'mail.protonmail.com': ['protonmail.com', 'proton.me', 'pm.me'], 'account.proton.me': ['protonmail.com', 'proton.me', 'pm.me'],
  'account.protonvpn.com': ['protonmail.com', 'proton.me', 'pm.me'],
  'account-bs.gmx.com': ['gmx.com'], 'signup.gmx.com': ['gmx.com'], 'signup.mail.com': ['mail.com'],
}
const NOISE_DOMAINS = new Set(['', 'http', 'https'])

// Per-query limits. `http_wait_end_of_query` keeps a timeout from arriving as a half-written JSON body (see lib/clickhouse.ts).
const SET = `SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, max_threads = 4, use_query_cache = 0, optimize_use_projections = 0`
// A query that must stop early once it has seen enough groups: `break` returns what was found so far instead of reading on (and on, for a handle such as
// "john", across most of the table until the 30 s limit). The caller reads a full group count as "too common".
const capped = (groups: number) => `${SET}, max_rows_to_group_by = ${groups}, group_by_overflow_mode = 'break'`
const SET_POP = capped(ASSOCIATE_LIMITS.popularityCap)
const SET_OWN = capped(ASSOCIATE_LIMITS.maxGroups)
const SET_ANCHOR = capped(ASSOCIATE_LIMITS.maxAnchorGroups)

/** What went wrong, never why in detail: an error text can quote the query, and the query holds a password. */
function errorKind(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/TIMEOUT_EXCEEDED|timeout|timed out/i.test(msg)) return 'timed out'
  if (/MEMORY_LIMIT_EXCEEDED|memory limit/i.test(msg)) return 'memory limit'
  if (isConnectionError(e)) return 'connection failed'
  return 'query failed'
}

const str = (v: unknown) => (typeof v === 'string' ? v : String(v ?? ''))

export async function associateLogin(
  item: AssociateItem,
  run: QueryRunner,
  opts: { now?: () => number; budgetMs?: number; range?: ImportedRange } = {},
): Promise<AssociateResult> {
  const L = ASSOCIATE_LIMITS
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.budgetMs ?? L.itemBudgetMs)
  let budgetNoted = false
  const n = item.login
  const handle = asciiLower(n)
  const want = item.want
  const tc = tokenClause(n)
  const errors: string[] = []
  const base: Record<string, unknown> = { n, ...tc.params }
  // The imported window, for the queries that produce candidates (not the ones that identify the account).
  const win = opts.range && hasImportedRange(opts.range) ? importedRangePlain(opts.range) : null
  const inWin = win ? `, max(${win.conditions.join(' AND ')}) AS in_win` : ''
  const winParams: Record<string, unknown> = win ? win.params : {}
  /** Without a window every row qualifies; with one, only the groups that have a row in it. */
  const qualifies = (r: Row) => !win || Number(r.in_win) === 1

  const attempt = async (stage: string, tag: string, sql: string, params: Record<string, unknown>): Promise<Row[] | null> => {
    if (now() > deadline) {
      if (!budgetNoted) errors.push(`time budget: stopped probing after ${Math.round((opts.budgetMs ?? L.itemBudgetMs) / 1000)} s`)
      budgetNoted = true
      return null
    }
    try {
      return await run(`/* assoc:${tag} */ ${sql}`, params)
    } catch (e) {
      errors.push(`${stage}: ${errorKind(e)}`)
      return null
    }
  }

  const result: AssociateResult = { login: n, want, anchored: false, tooCommon: false, loginSites: [], candidatesTotal: 0, candidates: [], errors }

  // 1. the login's own rows: its sites and passwords
  const own = await attempt('login', 'own', `SELECT domain, password FROM ulp.credentials
    WHERE ${tc.sql} AND ${addressEquals('n')}
    GROUP BY domain, password LIMIT ${L.maxGroups} ${SET_OWN}`, base)
  if (own === null) return result
  if (own.length >= L.maxGroups) result.tooCommon = true
  const pairs: Array<[string, string]> = own.map(r => [str(r.domain), str(r.password)] as [string, string]).filter(([d, p]) => !NOISE_DOMAINS.has(d) && p !== '')
  result.loginSites = [...new Set(pairs.map(([d]) => d))].sort()
  const distinctive = result.loginSites.length <= L.distinctiveSites

  // The pairs that pin the account: the login's rows on the given site, found by their own query so the cap on the query above cannot hide them,
  // and the caller's own password for that site.
  const anchorPairs: Array<[string, string]> = []
  const addAnchor = (d: string, p: string) => {
    if (p !== '' && !anchorPairs.some(([ad, ap]) => ad === d && ap === p)) anchorPairs.push([d, p])
  }
  if (item.site) {
    for (const [d, p] of pairs) if (d === item.site) addAnchor(d, p)
    const a = await attempt('site', 'anchor', `SELECT password FROM ulp.credentials
      WHERE domain = {site:String} AND ${addressEquals('n')}
      GROUP BY password LIMIT ${L.maxAnchorGroups} ${SET_ANCHOR}`, { n, site: item.site })
    for (const r of a ?? []) addAnchor(item.site, str(r.password))
    if (item.password) addAnchor(item.site, item.password)
  }
  const anchored = anchorPairs.length > 0 || Boolean(item.password)
  result.anchored = anchored

  const basis = anchorPairs.length > 0 ? anchorPairs : pairs
  const pwSet = new Set<string>()
  for (const [, p] of basis) if (p.length >= L.minReusePasswordLength) pwSet.add(p)
  if (item.password && item.password.length >= L.minReusePasswordLength) pwSet.add(item.password)
  const basisPws = [...pwSet].sort().slice(0, L.maxPasswords)

  const cands = new Map<string, CandidateState>()
  const cand = (login: string) => {
    let c = cands.get(login)
    if (!c) cands.set(login, (c = newCandidateState()))
    return c
  }

  // 2. S1: logins on the same site with the same password. The anchor pairs identify the person; the login's rows on other sites are probed too, but they may
  // belong to someone else with the same handle.
  const s1: Array<[string, string, boolean]> = basis.slice(0, L.maxPairs).map(([d, p]) => [d, p, anchorPairs.length > 0])
  if (anchorPairs.length > 0) {
    const seen = new Set(anchorPairs.map(([d, p]) => `${d}\u0000${p}`))
    for (const [d, p] of pairs.filter(([d2, p2]) => !seen.has(`${d2}\u0000${p2}`)).slice(0, L.maxPairs)) s1.push([d, p, false])
  }
  for (const [d, p, tied] of s1) {
    const others = await attempt('site', 's1', `SELECT lower(email) AS e, login_type${inWin} FROM ulp.credentials
      WHERE domain = {d:String} AND password = {p:String} AND lower(email) != lower({n:String})
      GROUP BY e, login_type LIMIT 200 ${SET}`, { n, d, p, ...winParams })
    if (others === null) continue
    for (const o of others) {
      if (str(o.login_type) !== want || !qualifies(o)) continue
      cand(str(o.e)).inWindow = true
      const bucket = tied ? cand(str(o.e)).pwSite : cand(str(o.e)).pwSiteOther
      bucket.set(d, Math.min(bucket.get(d) ?? Number.MAX_SAFE_INTEGER, others.length))
    }
  }

  // 3. S2: logins on any site that use one of the account's passwords (popularity-gated)
  for (const p of basisPws) {
    const rows = await attempt('reuse', 's2', `SELECT lower(email) AS e, login_type, uniqExact(domain) AS sites${inWin} FROM ulp.credentials
      WHERE password = {p:String} AND lower(email) != lower({n:String})
      GROUP BY e, login_type ${SET_POP}`, { n, p, ...winParams })
    if (rows === null || rows.length >= L.popularityCap) continue // a common password tells nothing (counted over the whole table, window or not)
    for (const r of rows) {
      if (str(r.login_type) !== want || !qualifies(r)) continue
      const c = cand(str(r.e))
      c.inWindow = true
      c.pwGlobal = c.pwGlobal === null ? rows.length : Math.min(c.pwGlobal, rows.length)
      c.pwGlobalSites = Math.max(c.pwGlobalSites, Number(r.sites) || 0)
    }
  }

  // 4. S3 and S4 only make sense for an e-mail answer to a handle. S3 prunes with the login's words: with none to prune by it would read the whole table.
  let handleAddresses: number | null = null // with a window: the addresses with this handle in the whole table
  if (want === 'email' && !n.includes('@')) {
    const h = tc.sql === '1' ? null : await attempt('handle', 'handle', `SELECT lower(email) AS e, domain, count() AS rows${inWin} FROM ulp.credentials
      WHERE ${tc.sql} AND login_type = 'email'
        AND lower(substringUTF8(email, 1, position(email, '@') - 1)) = lower({n:String})
      GROUP BY e, domain ORDER BY rows DESC LIMIT ${L.maxGroups} ${SET_OWN}`, { ...base, ...winParams })
    if (h !== null) {
      if (h.length >= L.maxGroups) result.tooCommon = true
      // An address is a candidate when one of its rows is in the window; once it is, all of its rows describe it.
      const admitted = new Set(h.filter(qualifies).map(r => str(r.e)))
      if (win) handleAddresses = new Set(h.map(r => str(r.e))).size
      for (const r of h) {
        if (!admitted.has(str(r.e))) continue
        const c = cand(str(r.e))
        c.observed = true
        c.inWindow = true
        c.handleRows += Number(r.rows) || 0
        c.handleSites.add(str(r.domain))
      }
      if (basisPws.length > 0 && h.length > 0) {
        const tied = await attempt('handle', 'tied', `SELECT lower(email) AS e, domain${inWin} FROM ulp.credentials
          WHERE ${tc.sql} AND login_type = 'email'
            AND lower(substringUTF8(email, 1, position(email, '@') - 1)) = lower({n:String})
            AND password IN {pws:Array(String)}
          GROUP BY e, domain LIMIT ${L.maxGroups} ${SET_OWN}`, { ...base, ...winParams, pws: basisPws })
        for (const r of tied ?? []) {
          const e = str(r.e)
          if (win && !admitted.has(e) && !qualifies(r)) continue // with a window: an address qualifies through its own in-window row, or one of its handle rows
          const c = cand(e)
          c.tiedSites.add(str(r.domain))
          if (win && qualifies(r)) c.inWindow = true
        }
      }
    }
    for (const d of result.loginSites) for (const m of PROVIDERS[d] ?? []) cand(`${handle}@${m}`).provider.add(d)
  }

  const nHandle = handleAddresses ?? [...cands.values()].filter(c => c.observed).length
  const order = { high: 0, medium: 1, low: 2 }
  const ctx = { distinctive, nHandle, anchored }
  const ranked = [...cands.entries()]
    .filter(([, c]) => !win || c.inWindow)
    .map(([login, c]) => ({ login, c, confidence: confidenceOf(c, ctx) }))
    .sort((a, b) =>
      order[a.confidence] - order[b.confidence] ||
      minOf(a.c.pwSite) - minOf(b.c.pwSite) ||
      minOf(a.c.pwSiteOther) - minOf(b.c.pwSiteOther) ||
      (a.c.pwGlobal ?? 99) - (b.c.pwGlobal ?? 99) ||
      b.c.tiedSites.size - a.c.tiedSites.size ||
      b.c.handleRows - a.c.handleRows ||
      a.login.localeCompare(b.login))
  result.candidatesTotal = ranked.length
  result.candidates = ranked.slice(0, L.maxCandidates).map(({ login, c, confidence }) => ({ login, confidence, evidence: evidenceOf(c, item.site, anchored) }))
  return result
}

// ── Which logins use this password ─────────────────────────────────────────────────────────────────────────────

export const PASSWORD_LOOKUP_LIMITS = {
  maxPasswordLength: 256,
  defaultLimit: 100,
  maxLimit: 1000,
  /** Matching rows read at most; a more common password answers from the first rows in primary-key order and says `partial`. */
  scanCap: 100_000,
} as const

export type PasswordLoginType = WantedLogin | 'any'
const PASSWORD_TYPES: readonly PasswordLoginType[] = ['email', 'username', 'phone', 'any']

export interface PasswordLookup {
  password: string
  type: PasswordLoginType
  limit: number
  domain?: string
  /** imported_after (exclusive) / imported_before (inclusive); absent = every row. */
  range?: ImportedRange
}

export function parsePasswordLookup(raw: unknown): { ok: true; lookup: PasswordLookup } | { ok: false; error: string } {
  const L = PASSWORD_LOOKUP_LIMITS
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'the body must be a JSON object with a password' }
  const o = raw as Record<string, unknown>
  if (typeof o.password !== 'string' || o.password === '') return { ok: false, error: 'password is required and must be a non-empty string' }
  if (o.password.length > L.maxPasswordLength) return { ok: false, error: `password is longer than ${L.maxPasswordLength} characters` }
  const lookup: PasswordLookup = { password: o.password, type: 'email', limit: L.defaultLimit }
  if (o.type !== undefined && o.type !== null) {
    if (typeof o.type !== 'string' || !PASSWORD_TYPES.includes(o.type as PasswordLoginType)) return { ok: false, error: `type must be one of ${PASSWORD_TYPES.join(', ')}` }
    lookup.type = o.type as PasswordLoginType
  }
  if (o.limit !== undefined && o.limit !== null) {
    if (typeof o.limit !== 'number' || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > L.maxLimit) return { ok: false, error: `limit must be a whole number from 1 to ${L.maxLimit}` }
    lookup.limit = o.limit
  }
  if (o.domain !== undefined && o.domain !== null && o.domain !== '') {
    if (typeof o.domain !== 'string') return { ok: false, error: 'domain must be a string' }
    const domain = normalizeSite(o.domain)
    if (!domain) return { ok: false, error: 'domain must be a bare host name such as example.com' }
    lookup.domain = domain
  }
  const window = parseImportedRange({ imported_after: o.imported_after, imported_before: o.imported_before })
  if (!window.ok) return { ok: false, error: window.error }
  if (hasImportedRange(window.range)) lookup.range = window.range
  return { ok: true, lookup }
}

export function buildPasswordLookupSql(l: PasswordLookup): { sql: string; params: Record<string, unknown>; scanCap: number } {
  const scanCap = PASSWORD_LOOKUP_LIMITS.scanCap
  const where = ['password = {p:String}']
  const params: Record<string, unknown> = { p: l.password }
  if (l.type !== 'any') {
    where.push('login_type = {t:String}')
    params.t = l.type
  }
  if (l.domain) {
    where.push('domain = {d:String}')
    params.d = l.domain
  }
  if (l.range) {
    const w = importedRangePlain(l.range)
    where.push(...w.conditions)
    Object.assign(params, w.params)
  }
  params.scan = scanCap
  params.lim = l.limit + 1 // one more than asked, to know whether there is more
  const sql = `/* assoc:password */ SELECT login, any(login_type) AS login_type, uniqExact(domain) AS sites, groupUniqArray(5)(domain) AS domains,
      count() AS rows, sum(rows) OVER () AS scanned
    FROM (
      SELECT lower(email) AS login, login_type, domain FROM ulp.credentials
      WHERE ${where.join(' AND ')}
      LIMIT {scan:UInt32}
    )
    GROUP BY login ORDER BY sites DESC, rows DESC, login ASC LIMIT {lim:UInt32}
    ${SET}`
  return { sql, params, scanCap }
}

export interface PasswordLoginRow {
  login: string
  loginType: string
  sites: number
  domains: string[]
  rows: number
}

export async function lookupPassword(l: PasswordLookup, run: QueryRunner): Promise<{ results: PasswordLoginRow[]; partial: boolean; hasMore: boolean }> {
  const { sql, params, scanCap } = buildPasswordLookupSql(l)
  const rows = await run(sql, params)
  return {
    results: rows.slice(0, l.limit).map(r => ({
      login: str(r.login),
      loginType: str(r.login_type),
      sites: Number(r.sites) || 0,
      domains: Array.isArray(r.domains) ? r.domains.map(str) : [],
      rows: Number(r.rows) || 0,
    })),
    partial: rows.length > 0 && Number(rows[0].scanned) >= scanCap,
    hasMore: rows.length > l.limit,
  }
}
