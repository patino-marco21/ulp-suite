/**
 * The substring plan (design: docs/superpowers/specs/2026-10-13-word-and-substring-search-plans-design.md).
 *
 * A text with a special character in it (a path, `user:pass`, a space) is searched as `url LIKE '%x%' OR email LIKE '%x%' OR password LIKE '%x%'`
 * (lib/ulp-search.ts, the `like` type), which no skip index prunes: every granule is read, about 95 GiB, 35-42 s warm, 72-82 s as logged. But a
 * WORD inside the text is a necessary condition of the whole text: the word must be a whole token of any haystack that contains the text, and the
 * text indexes answer `hasToken` directly. The plan ANDs the rarest such word onto today's query, which keeps its LIKE predicate verbatim, so the
 * result can only equal today's.
 *
 * Which words are necessary. A run of ASCII letters and digits inside the needle with a character on both sides in the needle, both ASCII
 * non-alphanumeric and neither a LIKE metacharacter (`%`, `_` and the escape `\`). The text index cuts tokens at exactly the ASCII non-alphanumerics
 * and keeps every other character, non-ASCII ones included, inside a token (checked on all 128 ASCII characters and on samples of the rest, with the
 * production DDL). So such a run is a whole token of every haystack that matches the needle; a run at either end of the needle, or beside a wildcard
 * or a non-ASCII character, may be only part of one. The index lowercases (its preprocessor) and LIKE here does not, so lowercasing the word can only
 * widen the condition.
 *
 * The plan is used when the rarest word matches at most SUBSTRING_GATE_HITS rows (lib/search-plan-gate.ts); otherwise, and on any failure or overrun
 * of its budget, today's query runs.
 */
import { parseULPQuery, buildULPWhere, wordLeaves } from '@/lib/ulp-search'
import type { SearchScope } from '@/lib/search-scope'
import {
  searchTokenPlansEnabled, probeTokenHits, SUBSTRING_GATE_HITS, SUBSTRING_MAX_PROBES, type GateDeps,
} from '@/lib/search-plan-gate'

/**
 * The needle, when the whole search is exactly one positive, non-regex term of the `like` type looked up in every column; null for everything else
 * (a word, a domain, an address, several terms, negation, regex, a login scope), which keeps today's query. It comes out of buildULPWhere's own
 * LIKE parameter so the two cannot drift apart.
 */
export function substringNeedleFromQuery(q: string, regex: boolean, scope: SearchScope = 'all'): string | null {
  if (regex) return null
  const tokens = parseULPQuery(q, scope)
  if (tokens.length !== 1) return null
  const [token] = tokens
  if (token.type !== 'like' || token.negate || token.scope !== 'all') return null
  const { lk0 } = buildULPWhere(tokens).params
  if (typeof lk0 !== 'string' || lk0.length < 3 || !lk0.startsWith('%') || !lk0.endsWith('%')) return null
  return lk0.slice(1, -1)
}

/** A character that ends a token in the text index and that a LIKE pattern cannot consume: ASCII, and not `%`, `_` or the escape. (A run is maximal, so its neighbour is never a letter or digit.) */
const isHardSeparator = (c: string): boolean => c.charCodeAt(0) < 128 && c !== '%' && c !== '_' && c !== '\\'

/** The whole words of a needle (see the header): lowercase, without repeats, in order of appearance. */
export function wholeTokens(needle: string): string[] {
  const words: string[] = []
  for (const m of needle.matchAll(/[A-Za-z0-9]+/g)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (start === 0 || end === needle.length) continue
    if (!isHardSeparator(needle[start - 1]) || !isHardSeparator(needle[end])) continue
    words.push(m[0].toLowerCase())
  }
  return [...new Set(words)]
}

export interface SubstringChoice {
  /** The lowercase word to AND on. */
  token: string
  /** How many rows it matches (a probe's count, at most the gate). */
  hits: number
}

/**
 * The rarest whole word of the needle when it passes the gate, else null (today's query). Probes the longest words first, at most
 * SUBSTRING_MAX_PROBES, in parallel; a probe that failed is ignored.
 */
export async function resolveSubstringChoice(needle: string, deps: GateDeps = {}): Promise<SubstringChoice | null> {
  if (!searchTokenPlansEnabled()) return null
  const words = wholeTokens(needle).sort((a, b) => b.length - a.length).slice(0, SUBSTRING_MAX_PROBES)
  if (words.length === 0) return null
  const counts = await Promise.all(words.map(word => probeTokenHits(word, deps)))
  let best: SubstringChoice | null = null
  for (let i = 0; i < words.length; i++) {
    const hits = counts[i]
    if (hits === null || hits > SUBSTRING_GATE_HITS) continue
    if (best === null || hits < best.hits) best = { token: words[i], hits }
  }
  return best
}

/** The name of the plan's one query parameter. */
export const SUBSTRING_PARAM = 'sbt'

/** What the plan ANDs onto today's WHERE: the word's three text-index leaves (the word search's own spelling) and their parameter. */
export function substringConjunct(token: string): { sql: string; params: Record<string, string> } {
  return { sql: ` AND (${wordLeaves(SUBSTRING_PARAM)})`, params: { [SUBSTRING_PARAM]: token } }
}
