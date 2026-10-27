/**
 * Whether Declutter starts on for a search (a click on the chip always overrides it).
 *
 * Declutter hides IP-address hosts, URLs with a :port, every URL that ends in .php and rows the parser mangled (lib/ulp-noise.ts). Measured on the
 * live table (docs/superpowers/specs/2026-10-26-site-counts-design.md, last section), that is:
 *   - clutter in a browse and in a broad search: the default view without it opens on 198 junk rows out of 200, and the logins admin and root
 *     are 56% and 71% hidden rows, nearly all router panels;
 *   - a loss in a lookup of ONE thing: a site that runs on .php lost 40% of its rows, one site lost every row (a search for it showed 0 records),
 *     5.9% of addresses lost a row and 1.3% lost them all, and an IP address can never be found, because its rows are the rule's first target.
 * So it starts on for the first and off for the second. Pure: the Credentials page and its tests both use it.
 */
import { parseULPQuery, type ParsedToken } from '@/lib/ulp-search'
import type { SearchScope } from '@/lib/search-scope'

export interface DeclutterSearch {
  q: string
  scope: SearchScope
  regex: boolean
  /** The Domain box, the host filter and the e-mail domain filter: each names one site or domain exactly. */
  domain: string
  urlHost: string
  emailDomain: string
}

/** A term that names a single thing: an address, a site (or an IP), or a text with a path, a colon, a space or a symbol in it. */
function namesOneThing(term: ParsedToken): boolean {
  if (term.type === 'email_full' || term.type === 'email_dom') return true
  // In a login scope a word or a dotted name is a user name, which is broad (admin, john.smith): only a whole address names one person.
  if (term.scope !== 'all') return false
  return term.type === 'domain' || term.type === 'like'
}

export function declutterByDefault(search: DeclutterSearch): boolean {
  if (search.domain.trim() !== '' || search.urlHost.trim() !== '' || search.emailDomain.trim() !== '') return false
  // A pattern is a broad search, even when it looks like a site.
  if (search.regex) return true
  // Terms are ANDed, so one that names a single thing narrows the whole search to a lookup. A term that only excludes does not decide.
  const terms = parseULPQuery(search.q.trim(), search.scope).filter(t => !t.negate)
  return !terms.some(namesOneThing)
}
