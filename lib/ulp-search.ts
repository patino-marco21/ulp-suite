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
 *                → email = lower(value)
 *                   Hits the bloom_filter(email) skip index for O(1) granule
 *                   pruning.  No LIKE fallback — substring search on emails
 *                   would bypass the index and scan every granule.
 *
 *   email_dom  — @-prefix only e.g. @gmail.com
 *                → email_domain = value (bloom_filter accelerated)
 *                   OR domain = value (bloom_filter accelerated — finds site creds too)
 *
 *   like       — contains special chars that break token splitting
 *                → LIKE '%value%' full scan (unavoidable; rare in practice)
 */

interface ParsedToken {
  negate: boolean
  type: 'token' | 'domain' | 'email_full' | 'email_dom' | 'like'
  value: string
  /** For email_full and email_dom: the lowercased domain part after @ */
  emailDomain?: string
}

export function parseULPQuery(raw: string): ParsedToken[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const negate = s.startsWith('-') && s.length > 1
      const value  = (negate ? s.slice(1).trim() : s).trim()

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
          return { negate, type: 'email_full' as const, value, emailDomain }
        } else {
          // Domain-only: @gmail.com → email_domain index
          return { negate, type: 'email_dom' as const, value, emailDomain }
        }
      }

      // Pure word token (alphanumeric + hyphen only) → hasToken()
      const isCleanToken = /^[\w-]+$/.test(value)
      if (isCleanToken) return { negate, type: 'token' as const, value }

      // Domain-shaped: two or more dot-separated labels (word chars/hyphens only)
      // → domain/host matching (see buildULPWhere's 'domain' branch for why this
      // is NOT routed through hasToken() -- it throws on any needle containing a
      // separator character, dots included). IP-shaped values like 192.168.1.1
      // also match this pattern and are intentionally included: domain =
      // '192.168.1.1' is a correct, useful lookup for IP-hosted credentials, and
      // this branch never touches hasToken() so there's no separator-character
      // error risk either way.
      const isDomainShaped = /^[\w-]+(\.[\w-]+)+$/.test(value)
      if (isDomainShaped) return { negate, type: 'domain' as const, value }

      return { negate, type: 'like' as const, value }
    })
    .filter(t => t.value.length > 0)
}

export function buildULPWhere(tokens: ParsedToken[]): { clause: string; params: Record<string, unknown> } {
  if (tokens.length === 0) return { clause: '1=1', params: {} }

  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  tokens.forEach((token, i) => {
    let match: string

    if (token.type === 'email_full') {
      // Exact match on the lowercased email.
      // Hits bloom_filter(email) skip index — skips granules that can't contain
      // the value without scanning them.  No LIKE fallback: substring search
      // on emails would bypass the index and force a full table scan.
      const ep = `exactemail${i}`
      params[ep] = token.value.toLowerCase()
      match = `(email = {${ep}:String})`

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
      match = `(hasToken(url, {${p}:String}) OR hasToken(email, {${p}:String}) OR hasToken(password, {${p}:String}) OR url_host LIKE {${lp}:String} OR email_domain LIKE {${lp}:String})`

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
    const match = `(match(url, {${p}:String}) OR match(email, {${p}:String}) OR match(password, {${p}:String}))`
    conditions.push(token.negate ? `NOT ${match}` : match)
  })

  return { clause: conditions.join(' AND '), params }
}
