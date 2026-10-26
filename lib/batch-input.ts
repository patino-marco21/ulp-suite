/**
 * What a person pastes into a batch lookup, turned into what ulp.credentials stores (design:
 * docs/superpowers/specs/2026-10-26-batch-lookup-design.md).
 *
 * The lookups compare a whole column to the value, so the value has to be in the shape the column holds:
 *   - `domain` is a bare, lower-case host: the parser (extractDomain, lib/ulp-parser.ts) drops the scheme, the path, any `user@`, the port and a
 *     leading `www.`. A pasted `https://www.site.tld/login` or `Site.TLD:8443` is none of that, matched nothing, and the answer looked like "clean".
 *   - `email` holds a login as typed; the lookup folds ASCII case on both sides. A pasted `mailto:a@b.tld`, `<a@b.tld>` or `a@b.tld:password`
 *     is not that login.
 *
 * Pure strings and no imports: the lookup page (a client component) and both batch routes share this file.
 */

/** The most entries one request may carry (the pages and the API agree on it). */
export const BATCH_MAX_QUERIES = 100

/** An entry longer than this after cleaning is not looked up: no host or address is this long, and every entry becomes a query parameter. */
export const BATCH_MAX_ENTRY_LENGTH = 512

/** Zero-width characters and the byte-order mark ride along when a list is copied from a web page or a spreadsheet. */
const INVISIBLE = /[​-‍⁠﻿]/g

/**
 * Lowercases A-Z only. ClickHouse's lower() (and the text index's preprocessor) fold ASCII case and leave every other letter alone, while
 * String.prototype.toLowerCase() also folds 'É' to 'é'. An address with such a letter is stored as typed, so folding it here would make the
 * value differ from the stored one.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, m => m.toLowerCase())
}

// ── Splitting the pasted text ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A piece such as "a.tld b.tld" or "a@x.tld b@y.tld" is a list pasted on one line when EVERY word is an address, a host or a URL. */
function splitSpaced(piece: string): string[] {
  if (!/\s/.test(piece)) return [piece]
  const words = piece.split(/\s+/)
  const listLike = words.every(w => /^\S+@\S+$/.test(w) || /^\S+:\/\/\S+$/.test(w) || /^[^\s/@]+\.[^\s/@]+(\/\S*)?$/.test(w))
  return listLike ? words : [piece]
}

/** The entries of a pasted list: one per line, comma or semicolon, trimmed, empty ones dropped, an exact repeat kept once. */
export function parseBatchText(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of raw.split(/[\r\n,;]+/)) {
    for (const entry of splitSpaced(piece.trim())) {
      if (entry && !seen.has(entry)) {
        seen.add(entry)
        out.push(entry)
      }
    }
  }
  return out
}

// ── Domains ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DomainEntry {
  /** The bare host the parser would store for this input ('' when there is nothing usable). */
  host: string
  /**
   * Every stored `domain` value the input can mean, best first: the host, the host with its `www.` back (4,605 of 2.23 billion rows keep one), and
   * the text as typed (226,642 rows kept a `:port` and 1.37 million a `/path` from before the parser stripped them, so an input that matched one of
   * them exactly still does). An input with a scheme is not added as typed: no stored domain is a URL.
   */
  candidates: string[]
}

/**
 * The same cut the parser makes (extractDomain), made tolerant of what people paste: surrounding quotes or brackets, a protocol-relative `//host`,
 * a `?query` or `#fragment` straight after the host, a trailing dot, text after a space.
 */
export function domainEntry(raw: string): DomainEntry {
  const typed = raw.replace(INVISIBLE, '').trim().toLowerCase()
  let s = typed.replace(/^[<"'`([]+/, '').replace(/[>"'`)\].,;]+$/, '')
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(s)
  if (scheme) s = s.slice(scheme[0].length)
  else if (s.startsWith('//')) s = s.slice(2)
  const end = s.search(/[/\\?#\s]/)
  if (end !== -1) s = s.slice(0, end)
  const at = s.lastIndexOf('@')
  if (at !== -1) s = s.slice(at + 1)
  s = s.replace(/:\d+$/, '').replace(/\.+$/, '')

  const withWww = s
  const host = s.replace(/^www\./, '')
  const candidates: string[] = []
  const add = (value: string) => {
    if (value && value.length <= BATCH_MAX_ENTRY_LENGTH && !candidates.includes(value)) candidates.push(value)
  }
  add(host)
  add(withWww)
  if (!typed.includes('://')) add(typed)
  return { host, candidates }
}

// ── E-mail addresses (and other logins) ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The login to look up for a pasted entry. Something without an '@' is a username or a phone number: only quotes around it are removed.
 * Something with one is reduced to the address in it: `Name <a@b.tld>`, `<a@b.tld>`, `"a@b.tld"`, `mailto:a@b.tld`, `a@b.tld:password`,
 * `a@b.tld.`. A `'` inside is kept (o'brien@b.tld is an address); only the characters that cannot be in one end the match.
 */
export function cleanEmailEntry(raw: string): string {
  let s = raw.replace(INVISIBLE, '').replace(/ /g, ' ').trim()
  if (!s.includes('@')) return s.replace(/^["'`]+|["'`]+$/g, '').trim()
  const angle = /<([^<>]*@[^<>]*)>/.exec(s)
  if (angle) s = angle[1]
  s = s.replace(/^mailto:/i, '')
  const token = /[^\s<>"`,;:|()[\]]+@[^\s<>"`,;:|()[\]]+/.exec(s)
  if (token) s = token[0]
  return s.replace(/^['"`]+|['"`]+$/g, '').replace(/[.,;:!?)]+$/, '').trim()
}

// ── Choosing e-mail or domain for each line ───────────────────────────────────────────────────────────────────────────────────────

export type BatchKind = 'email' | 'domain'

/**
 * A URL is a domain; an address (an '@' with no path after it) is an e-mail; a line that says neither follows `ambiguous`, which is
 * the page's Email/Domain choice. The API takes both lists in one request, so one pasted list can hold both.
 */
export function classifyBatchLine(line: string, ambiguous: BatchKind): BatchKind {
  if (line.includes('://') || line.startsWith('//')) return 'domain'
  if (line.includes('@')) return line.includes('/') ? 'domain' : 'email'
  return ambiguous
}

export interface BatchRequestLists {
  emails: string[]
  domains: string[]
}

/** The two lists of a request body for a pasted text. */
export function buildBatchRequest(text: string, ambiguous: BatchKind): BatchRequestLists {
  const emails: string[] = []
  const domains: string[] = []
  for (const line of parseBatchText(text)) {
    ;(classifyBatchLine(line, ambiguous) === 'email' ? emails : domains).push(line)
  }
  return { emails, domains }
}

/**
 * The Email/Domain choice a page should start with for a pasted text: Email as soon as any line carries an '@' (an address), else Domain.
 * Only lines that say neither follow it (classifyBatchLine), so a mixed list is not forced one way.
 */
export function suggestBatchKind(text: string): BatchKind {
  return /@/.test(text) ? 'email' : 'domain'
}

// ── The index prefilter for e-mail lookups ────────────────────────────────────────────────────────────────────────────────────────

/** Most words of an address that go into the prefilter, and the longest word allowed in it. */
export const PREFILTER_MAX_WORDS = 8
export const PREFILTER_MAX_WORD_LENGTH = 64

/**
 * The words the text index on `email` (tokenizer splitByNonAlpha, preprocessor lower(email)) holds for any row whose login equals `lowered`: the
 * maximal runs of ASCII letters and digits of the ASCII-lowercased login (checked against ClickHouse's own tokens(lower(email), 'splitByNonAlpha')
 * on 5,000,000 real logins: identical in every row). A row that matches the address has all of them, so asking the index for rows that have them
 * all can only drop granules that hold no match. The longest words come first: they are the rarest.
 *
 * null when no prefilter can be built safely: the login has no word at all (nothing but punctuation), it has a non-ASCII character (the index's
 * cut of those is not validated here) or one of its words is too long to send. Such an entry is looked up without a prefilter.
 */
export function prefilterWords(lowered: string): string[] | null {
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(lowered)) return null
  const words = Array.from(new Set(lowered.match(/[a-z0-9]+/g) ?? []))
  if (words.length === 0 || words.some(w => w.length > PREFILTER_MAX_WORD_LENGTH)) return null
  return words.sort((a, b) => b.length - a.length).slice(0, PREFILTER_MAX_WORDS)
}
