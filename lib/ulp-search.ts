/**
 * Shared ULP search query builder.
 *
 * Token types and their index strategy:
 *
 *   token      — pure alphanumeric/hyphen word
 *                → hasToken(url/email/password, value)
 *                   Uses tokenbf_v1 skip indexes on all three columns.
 *                   Skips entire 8 192-row granules that provably can't match.
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
  type: 'token' | 'email_full' | 'email_dom' | 'like'
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
      return { negate, type: isCleanToken ? 'token' as const : 'like' as const, value }
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
      // Pure word: use hasToken() which leverages tokenbf_v1 skip index on url/email/password
      const p = `tok${i}`
      params[p] = token.value
      match = `(hasToken(url, {${p}:String}) OR hasToken(email, {${p}:String}) OR hasToken(password, {${p}:String}))`

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
