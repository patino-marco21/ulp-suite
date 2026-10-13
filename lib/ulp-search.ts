/**
 * Shared ULP search query builder.
 *
 * Token types and their index strategy:
 *
 *   token      — pure alphanumeric/hyphen word
 *                → hasToken(url/email/password, lower(value))
 *                   Uses text() inverted indexes on all three columns
 *                   (ClickHouse 26.x: TYPE text(tokenizer=splitByNonAlpha, preprocessor=lower(col))).
 *                   Skips entire 65 536-row granules that provably can't match.
 *                   Value is always lowercased: the index preprocessor lowercases stored
 *                   tokens; passing uppercase would silently return 0 results for 'GOOGLE'.
 *                → url_host LIKE '%' || lower(value) || '%'
 *                   Catches compound-domain substrings: "ledger" matches
 *                   coinledger.com, ledgernano.com, etc.  url_host is a
 *                   lowercased materialized column with an ngrambf_v1 skip index
 *                   (idx_ngram_url_host), so LIKE both scans a compact column AND
 *                   gets granule pruning ('_' in the value is escaped to '\_' since
 *                   it's a LIKE wildcard).
 *                → email_domain LIKE '%' || lower(value) || '%'
 *                   Same logic for the email domain column (idx_ngram_email_domain).
 *
 *   domain     — 2+ dot-separated labels e.g. ledger.com, trezor.io, mail.google.com
 *                → domain = lower(value)
 *                   Exact site match. `domain` is the table's own leading ORDER BY
 *                   column, so this is accelerated by the primary key itself, not a
 *                   skip index (confirmed live: 11/8833 granules read via binary
 *                   search, ~100ms).
 *                → domain LIKE '%.' || lower(value)
 *                   Subdomains (beta.ledger.com). Not primary-key accelerated (the
 *                   leading wildcard defeats prefix binary search), but scanning the
 *                   compact `domain` column alone is cheap even unindexed.
 *                → url_host LIKE '%' || lower(value) || '%'
 *                   Compound/embedded matches (coinledger.io, or a phishing domain
 *                   that embeds the target string) — same ngrambf_v1-accelerated
 *                   mechanism as the token type's url_host clause above.
 *                → email_domain LIKE '%' || lower(value) || '%'
 *                   Credentials with a matching email domain.
 *                   Deliberately does NOT use hasToken(): it throws
 *                   (BAD_ARGUMENTS, "Needle must not contain whitespace or separator
 *                   characters") on any needle containing a separator character —
 *                   confirmed live — so a dotted value can never be passed to it.
 *
 *   email_full — full email e.g. john@gmail.com
 *                → lower(email) = lower(value)
 *                   Hits the bloom_filter(lower(email)) skip index (idx_bf_email_lc,
 *                   lib/address-lookup.ts) for granule pruning, and finds every stored
 *                   casing of the address (logins are kept as typed).  No LIKE
 *                   fallback — substring search on emails would bypass the index
 *                   and scan every granule.
 *
 *   email_dom  — @-prefix only e.g. @gmail.com
 *                → email_domain = value (bloom_filter accelerated)
 *                   OR domain = value (bloom_filter accelerated — finds site creds too)
 *
 *   like       — contains special chars that break token splitting
 *                → LIKE '%value%' full scan (unavoidable; rare in practice)
 *
 * Scopes (lib/search-scope.ts): a term is looked up in every column ('all', the default), as a whole word in the login ('login') or anywhere in the
 * login ('login_contains'). A `login:` prefix on a term always means 'login'. buildLoginMatch has the SQL of the two login scopes.
 */
import type { SearchScope } from '@/lib/search-scope'
export type { SearchScope } from '@/lib/search-scope'
import { addressEquals } from '@/lib/address-lookup'

export interface ParsedToken {
  negate: boolean
  type: 'token' | 'domain' | 'email_full' | 'email_dom' | 'like'
  value: string
  /** For email_full and email_dom: the lowercased domain part after @ */
  emailDomain?: string
  /** Where the term is looked up: every column, a whole word in the login, or anywhere in the login. */
  scope: SearchScope
}

/** A term that starts with this is a whole-word lookup in the login, whatever the default scope is. */
const LOGIN_PREFIX = /^login:/i

/** The type of a term (and the domain of an address) by the shape of its value. The scope is not part of it. */
function classifyTerm(value: string, negate: boolean): Omit<ParsedToken, 'scope'> {
  if (value.includes('@')) {
    const atIdx     = value.indexOf('@')
    const localPart = value.slice(0, atIdx)
    const rawDomain = value.slice(atIdx + 1)
    const emailDomain = rawDomain
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase()

    if (localPart.length > 0 && emailDomain.length > 0) {
      // Full email: john@gmail.com → exact bloom-filter lookup
      return { negate, type: 'email_full', value, emailDomain }
    }
    // Domain-only: @gmail.com → email_domain index
    return { negate, type: 'email_dom', value, emailDomain }
  }

  // Pure word token (alphanumeric + hyphen only) → hasToken()
  if (/^[\w-]+$/.test(value)) return { negate, type: 'token', value }

  // Domain-shaped: two or more dot-separated labels (word chars/hyphens only)
  // → domain/host matching (see buildULPWhere's 'domain' branch for why this
  // is NOT routed through hasToken() -- it throws on any needle containing a
  // separator character, dots included). IP-shaped values like 192.168.1.1
  // also match this pattern and are intentionally included: domain =
  // '192.168.1.1' is a correct, useful lookup for IP-hosted credentials, and
  // this branch never touches hasToken() so there's no separator-character
  // error risk either way.
  if (/^[\w-]+(\.[\w-]+)+$/.test(value)) return { negate, type: 'domain', value }

  return { negate, type: 'like', value }
}

export function parseULPQuery(raw: string, defaultScope: SearchScope = 'all'): ParsedToken[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const negate = s.startsWith('-') && s.length > 1
      let value = (negate ? s.slice(1).trim() : s).trim()
      let scope = defaultScope
      if (LOGIN_PREFIX.test(value)) {
        scope = 'login'
        value = value.replace(LOGIN_PREFIX, '').trim()
      }
      return { ...classifyTerm(value, negate), scope }
    })
    .filter(t => t.value.length > 0)
}

/**
 * True when the search means the same thing whichever of the table's physical copies a query reads (the base table, or a projection
 * such as proj_imported_desc). Word tokens do not: `hasToken(col, tok)` on the base table is answered from the text index, whose
 * preprocessor is `lower(col)` (case-INSENSITIVE), but a projection part has no text index, so there it runs as the plain function on the
 * stored text (case-SENSITIVE) and silently drops mixed-case matches. LIKE-fallback tokens and regexes are not vouched for either.
 * Domain, email and @domain terms compare whole columns, and no query at all has nothing to differ on. A Login (contains) term is a plain function of
 * the login column, the same in either copy; a Login (whole word) word or phrase uses hasToken and is not neutral (an address or @host in a login
 * scope is).
 */
export function isIndexNeutralSearch(tokens: ParsedToken[], regexMode = false): boolean {
  if (tokens.length === 0) return true
  if (regexMode) return false
  return tokens.every(t => {
    if (t.type === 'email_full' || t.type === 'email_dom') return true
    if (t.scope === 'login_contains') return true
    if (t.scope === 'login') return false
    return t.type === 'domain'
  })
}

/**
 * True when a term of the search is answered through the lower(email) index (idx_bf_email_lc), so the query must also carry
 * ADDRESS_LOOKUP_SETTING (lib/address-lookup.ts): with a projection to choose from the planner reads it whole and never uses the index.
 * Login (contains) is a substring scan of the login column and regex mode has its own clause; neither uses it.
 */
export function usesAddressIndex(tokens: ParsedToken[], regexMode = false): boolean {
  return !regexMode && tokens.some(t => t.type === 'email_full' && t.scope !== 'login_contains')
}

/** Most words of a value that become a hasToken each in a whole-word login search; the phrase check enforces the rest. */
const MAX_LOGIN_WORDS = 8

/** Lowercases A-Z only: ClickHouse's lower() and the text index's preprocessor fold ASCII case and leave every other letter as it is. */
const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, m => m.toLowerCase())

/**
 * The words of a value the way the text index cuts a login (splitByNonAlpha): maximal runs of ASCII letters and digits and of non-ASCII
 * characters, ASCII-lowercased, without repeats.
 */
export function loginWords(value: string): string[] {
  return Array.from(new Set(asciiLower(value).match(/[a-z0-9\u0080-\uffff]+/g) ?? []))
}

/** A full address as an exact match on the login that ignores case (bloom filter on lower(email), lib/address-lookup.ts). Its parameter is added to `params`. */
function exactAddressMatch(token: ParsedToken, i: number, params: Record<string, unknown>): string {
  const name = `exactemail${i}`
  params[name] = token.value
  return `(${addressEquals(name)})`
}

/**
 * The SQL of a term whose scope is a login scope: only the login column (`email`) is looked at, and for @host its domain column.
 *   login           a word: hasToken on the text index; a dotted or special value: every word of it, then the phrase itself
 *   login_contains  a case-insensitive substring scan of the login column
 *   either          an address keeps the exact match (whole word) or is a substring (contains); @host is email_domain = host
 */
function buildLoginMatch(
  token: ParsedToken, i: number, col: (name: string) => string,
): { match: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {}

  if (token.type === 'email_dom') {
    const p = `edom${i}`
    params[p] = (token.emailDomain ?? '').toLowerCase()
    return { match: `(email_domain = {${p}:String})`, params }
  }

  if (token.scope === 'login_contains') {
    const p = `lc${i}`
    params[p] = token.value
    return { match: `(positionCaseInsensitive(email, {${p}:String}) > 0)`, params }
  }

  if (token.type === 'email_full') return { match: exactAddressMatch(token, i, params), params }

  const words = loginWords(token.value)
  if (words.length === 1 && words[0] === asciiLower(token.value)) {
    const p = `lw${i}`
    params[p] = words[0]
    return { match: `(hasToken(${col('email')}, {${p}:String}))`, params }
  }

  const parts = words.slice(0, MAX_LOGIN_WORDS).map((w, j) => {
    const p = `lw${i}_${j}`
    params[p] = w
    return `hasToken(${col('email')}, {${p}:String})`
  })
  const pp = `lp${i}`
  params[pp] = token.value
  parts.push(`positionCaseInsensitive(email, {${pp}:String}) > 0`)
  return { match: `(${parts.join(' AND ')})`, params }
}

/**
 * The three text-index leaves of a word: `hasToken` on url, email and password (the `text()` indexes answer them, case-insensitively, through their
 * lower() preprocessor). `col` spells the column: a projection has no text index, so a query that reads one writes `lower(col)`
 * (BuildULPWhereOptions.caseInsensitiveTokens). The word search and the token plans (lib/search-substring-plan.ts) build their leaves here, so the
 * spellings cannot drift apart.
 */
export function wordLeaves(param: string, col: (name: string) => string = name => name): string {
  return `hasToken(${col('url')}, {${param}:String}) OR hasToken(${col('email')}, {${param}:String}) OR hasToken(${col('password')}, {${param}:String})`
}

export interface BuildULPWhereOptions {
  /**
   * Write word-token predicates over the lowercased column (`hasToken(lower(url), tok)`): the same case-insensitive match the text index's
   * own preprocessor gives on the base table, for a query that reads a projection (which has no text index). Everything else is unchanged.
   */
  caseInsensitiveTokens?: boolean
}

export function buildULPWhere(tokens: ParsedToken[], opts: BuildULPWhereOptions = {}): { clause: string; params: Record<string, unknown> } {
  if (tokens.length === 0) return { clause: '1=1', params: {} }

  const conditions: string[] = []
  const params: Record<string, unknown> = {}
  const col = (name: string) => (opts.caseInsensitiveTokens ? `lower(${name})` : name)

  tokens.forEach((token, i) => {
    let match: string

    if (token.scope === 'login' || token.scope === 'login_contains') {
      // A login scope: only the login column is looked at (buildLoginMatch).
      const built = buildLoginMatch(token, i, col)
      Object.assign(params, built.params)
      match = built.match

    } else if (token.type === 'email_full') {
      // Exact match that ignores case (exactAddressMatch). Hits the bloom_filter(lower(email)) skip index — skips granules that can't contain the
      // value without scanning them.  No LIKE fallback: substring search on emails would bypass the index and force a full table scan.
      match = exactAddressMatch(token, i, params)

    } else if (token.type === 'email_dom') {
      // @gmail.com → search the EMAIL domain column (stored lowercase).
      //   email_domain = 'gmail.com' → bloom_filter(email_domain) skip index
      //   domain       = 'gmail.com' → bloom_filter(domain) skip index
      //   The domain OR lets users find SITE credentials too (e.g. @google.com
      //   also finds https://google.com credentials stored with that site domain).
      const edp = `edom${i}`
      params[edp] = (token.emailDomain ?? '').toLowerCase()
      match = `(email_domain = {${edp}:String} OR domain = {${edp}:String})`

    } else if (token.type === 'token') {
      // Pure word: hasToken() leverages the text() inverted index on url/email/password
      // to prune entire granules that can't possibly match (e.g. searching "ledger" skips
      // granules that contain no occurrence of the word "ledger" as a whole token).
      //
      // Always lowercase the search value because:
      //   1. The index was created with preprocessor = lower(col), so stored tokens are
      //      always lowercase.  hasToken(url, 'GOOGLE') would return 0 rows even though
      //      google.com credentials exist — the token in the index is 'google', not
      //      'GOOGLE'.  Lowercasing normalises the needle to match stored tokens.
      //   2. url_host and email_domain are lower()-materialised columns, so the LIKE
      //      needle below already required a lowercase value too.
      //
      // Compound-domain substring matching: "ledger" must ALSO match "coinledger.com",
      // "ledgerwallet.com", etc. where "ledger" is embedded within a larger token.
      // url_host/email_domain LIKE '%value%' performs a substring scan of the
      // pre-extracted, lowercased hostname/domain columns AND lets ClickHouse use the
      // idx_ngram_url_host / idx_ngram_email_domain ngrambf_v1 skip indexes — unlike
      // position(col, value) > 0, which the bloom-filter index analyzer never recognizes
      // as prunable. '_' is escaped because it's a LIKE single-char wildcard and token
      // values (matched by /^[\w-]+$/) can contain it.
      const p = `tok${i}`
      const lp = `tlk${i}`
      const lower = token.value.toLowerCase()
      params[p] = lower
      params[lp] = `%${lower.replace(/_/g, '\\_')}%`
      match = `(${wordLeaves(p, col)} OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`

    } else if (token.type === 'domain') {
      // Domain-shaped (e.g. "ledger.com"): matches the canonical site column
      // directly rather than hasToken(), which throws (BAD_ARGUMENTS, "Needle
      // must not contain whitespace or separator characters" -- confirmed live)
      // on a needle containing a separator character. `domain = ` is
      // accelerated by the table's own primary key (domain is the leading
      // ORDER BY column) -- confirmed live: 11/8833 granules via binary search,
      // ~100ms. The LIKE '%.value' suffix condition is NOT a prefix condition
      // (leading wildcard), so it does not get that same acceleration, but
      // scanning the compact `domain` column alone is cheap regardless.
      // url_host / email_domain LIKE reuse the same ngrambf_v1-accelerated
      // mechanism as the 'token' branch above. '_' is escaped in the LIKE
      // patterns for the same reason as the 'token' branch.
      const lowerExact = token.value.toLowerCase()
      const lowerEscaped = lowerExact.replace(/_/g, '\\_')
      const ep = `dom${i}`
      const sp = `domsuf${i}`
      const lp2 = `domlk${i}`
      params[ep] = lowerExact
      params[sp] = `%.${lowerEscaped}`
      params[lp2] = `%${lowerEscaped}%`
      match = `(domain = {${ep}:String} OR domain LIKE {${sp}:String} OR url_host LIKE {${lp2}:String} OR email_domain LIKE {${lp2}:String})`

    } else {
      // LIKE fallback for tokens with special characters (no skip index)
      const p = `lk${i}`
      params[p] = `%${token.value}%`
      match = `(url LIKE {${p}:String} OR email LIKE {${p}:String} OR password LIKE {${p}:String})`
    }

    conditions.push(token.negate ? `NOT ${match}` : match)
  })

  return { clause: conditions.join(' AND '), params }
}

/**
 * Regex-mode query builder.
 * Each comma-separated term is treated as a RE2 regex pattern applied via
 * match() against url, email, and password.
 * Use for power-user queries like ^admin@, pass(word)?123, etc.
 */
export function buildULPWhereRegex(tokens: ParsedToken[]): { clause: string; params: Record<string, unknown> } {
  if (tokens.length === 0) return { clause: '1=1', params: {} }

  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  tokens.forEach((token, i) => {
    const p = `rp${i}`
    params[p] = token.value
    // A login scope looks at the login column only.
    const match = token.scope === 'all'
      ? `(match(url, {${p}:String}) OR match(email, {${p}:String}) OR match(password, {${p}:String}))`
      : `(match(email, {${p}:String}))`
    conditions.push(token.negate ? `NOT ${match}` : match)
  })

  return { clause: conditions.join(' AND '), params }
}
