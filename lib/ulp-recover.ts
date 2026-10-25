/**
 * Line layouts that parseLine used to reject and that parser v6 reads (docs/superpowers/specs/2026-10-12-parser-v6-and-redo-design.md). Each helper is pure and
 * returns null when the line is not of its shape. All of them are tried only AFTER the existing field split found nothing, except splitSpacePaddedColons:
 * the existing split returns white-space-padded fields for that shape, and the garbage gate then rejects them.
 * The parser v6.1 helpers at the end of the file (joinPipedUrl, holdsCredential, isUrlPathParameter) are not fallbacks: they decide what a pipe or a semicolon in
 * the line means before the separator rules run, and each acts only where the old rule produced junk (see "Parser v6.1" in the same spec).
 */

/** Ports a web server really listens on: a number after the host that is one of these is a port, not a login (rule D). */
export const COMMON_WEB_PORTS: ReadonlySet<number> = new Set([
  80, 81, 82, 88, 443, 444, 591, 631, 2082, 2083, 2086, 2087, 2095, 2096, 3000, 3001, 3128, 3306, 4443, 5000, 5001, 5432, 5601, 7001, 7443,
  8000, 8001, 8008, 8010, 8080, 8081, 8082, 8083, 8088, 8090, 8181, 8443, 8444, 8480, 8888, 8889, 9000, 9001, 9090, 9091, 9200, 9443, 10000, 10443, 20000,
])

/**
 * A "password" that is really a piece of a URL: a scheme, a leading slash, a host name followed by a slash, a leading www., a query string, a web file
 * extension, or three or more slashes. Used by the slash-in-password and protocol-relative rules, where the extra slash can belong to a path instead of the password.
 */
export function looksLikeUrlFragment(password: string): boolean {
  return password.includes('://')
    || password.startsWith('/')
    || /^www\./i.test(password)
    || /^[\w-]+(\.[\w-]+)+\//.test(password)
    || /[?&][\w%.-]+=/.test(password)
    || /\.(php|aspx?|html?|jsp|cgi)(\b|$)/i.test(password)
    || (password.match(/\//g) ?? []).length >= 3
}

// The lookbehind lets a match start only at the beginning of a run of white space. Without it every position inside a run is a start, and a run of n characters
// that is not followed by a colon costs n*n steps (one line of about 400,000 spaces held the importer's thread for minutes). A match that starts inside a run
// implies one at the start of the run (same colon, same trailing white space), so the leftmost match, its index and its length are exactly what they were.
const PADDED_COLON = /(?<!\s)\s+:\s+/
const EMAIL_SHAPE = /^[^\s/:@]+@[^\s/:@]+\.[^\s/:@]+$/

/**
 * "shop.example.test : alice@mail.test : Secret1": three fields separated by a colon with white space on both sides, no scheme. A first part that is an
 * e-mail address makes it "login : password" (the password may then hold anything). The host needs a dot or a slash and no white space, so a banner such as
 * "Join us : alice : Secret1" or "BTC : <emoji>" is not read. A password that holds another padded colon is ambiguous and refused.
 */
export function splitSpacePaddedColons(line: string): [string, string, string] | null {
  if (line.includes('://')) return null
  const first = PADDED_COLON.exec(line)
  if (!first) return null
  const head = line.slice(0, first.index)
  const afterFirst = line.slice(first.index + first[0].length)
  if (EMAIL_SHAPE.test(head)) {
    if (afterFirst === '' || PADDED_COLON.test(afterFirst)) return null
    return ['', head, afterFirst]
  }
  const second = PADDED_COLON.exec(afterFirst)
  if (!second) return null
  const login = afterFirst.slice(0, second.index)
  const password = afterFirst.slice(second.index + second[0].length)
  // A "host" with a colon is the start of "login:password : https : //url" (a credential followed by its padded url): not this rule, left as it was.
  if (!/[./]/.test(head) || head.includes(':') || /\s/.test(head) || /\s/.test(login) || login === '' || password === '' || PADDED_COLON.test(password)) return null
  return [head, login, password]
}

const SLASH_PASSWORD = /^(https?:\/\/[^/\s:@]+(?::\d{1,5})?):([^/\s:]+):(\S*\/\S*)$/i

/**
 * "https://shop.example.test:alice:Pass/word1": the first slash after the host belongs to the password, not to a path. The existing split takes the
 * first slash for the end of the url and finds one field too few. The password must not look like a URL fragment, and a number right after the host is
 * left to splitNumericLogin.
 */
export function splitSlashInPassword(line: string): [string, string, string] | null {
  const m = SLASH_PASSWORD.exec(line)
  if (!m) return null
  const [, url, login, password] = m
  if (/^\d{1,5}$/.test(login) && Number(login) <= 65535) return null
  if (looksLikeUrlFragment(password)) return null
  return [url, login, password]
}

const NUMERIC_LOGIN = /^(https?:\/\/[^/\s:@]+):(\d{1,5}):([^/\s:]+)$/i

/**
 * "https://shop.example.test:48213:Secret1": the existing split reads 48213 as a port (a number of up to five digits right after the host) and has
 * one field left, so the line is rejected. When the number is not a port a web server listens on, it is the login.
 */
export function splitNumericLogin(line: string): [string, string, string] | null {
  const m = NUMERIC_LOGIN.exec(line)
  if (!m) return null
  const n = Number(m[2])
  if (n > 65535 || COMMON_WEB_PORTS.has(n)) return null
  return [m[1], m[2], m[3]]
}

const PROTOCOL_RELATIVE = /^[^\s:@]+(?::\d{1,5}\/?[^\s:]*)?:[^\s:/]+:[^\s:]+$/

/**
 * "//shop.example.test/login:alice:Secret1": a protocol-relative url that parseLine used to take for a comment. Returns the line without its two slashes
 * (read as a scheme-less url, which is how such lines are stored), after a trailing ":http" / ":https" (a scheme some tools move to the end) is cut.
 * The host needs a dot, so "//TODO:fix:this" stays a comment.
 */
export function protocolRelativeToPlain(trimmed: string): string | null {
  if (!trimmed.startsWith('//') || trimmed.startsWith('///')) return null
  const rest = trimmed.slice(2).replace(/:https?$/i, '')
  if (!PROTOCOL_RELATIVE.test(rest)) return null
  const host = rest.split(/[/:]/)[0]
  return host.includes('.') ? rest : null
}

const ANDROID_WITHOUT_SCHEME = /^(\/\/)?[A-Za-z0-9_+-]{16,}==@[A-Za-z0-9_.-]+\/:/

/**
 * "HASH==@com.example.app/:alice@mail.test:Secret1": an Android app id that lost its "android://" prefix. Returns the line with the prefix put back, so it
 * is read like the lines that kept theirs.
 */
export function recoverAndroidAppLine(trimmed: string): string | null {
  const m = ANDROID_WITHOUT_SCHEME.exec(trimmed)
  if (!m) return null
  return m[1] ? `android:${trimmed}` : `android://${trimmed}`
}

// ─── Parser v6.1: a pipe that joins a url and a credential ───────────────────────────────────────────────────────────────────────────────────────────
const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:\/\/$/i
const ONE_WORD_LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,19}:$/
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
const BARE_HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d{1,5})?(\/\S*)?$/
/** "login:password" as it follows a url and a pipe: no slash or white space in the login, and not the start of "scheme://...". */
const LOGIN_PASSWORD = /^[^:\s/|]+:(?!\/\/)\S/
/** A credential line behind a label: after an optional scheme, a first field and a colon with something behind it. */
const CREDENTIAL_LINE = /^[^:\s|][^:|]*:\S/

/**
 * The text in front of a separator already holds a credential: two or more colons that are not part of "://" (url:login:password, host:login:password), or an
 * e-mail address followed by a colon (login:password with an e-mail login). What follows such a separator is then a note (a pipe) or part of the password (a semicolon).
 */
export function holdsCredential(before: string): boolean {
  const colons = (before.replace('://', '  ').match(/:/g) ?? []).length   // colons that are not part of a "://"
  return colons >= 2 || (colons === 1 && /^[^\s/:@]+@[^\s/:@]+:/.test(before))
}

/**
 * A ";name=value" path parameter at the start of a line: "https://host/login;jsessionid=AB12:alice:Secret1", and (parser v6.1) the same without the scheme, where the
 * host has a dot, a path follows, and the ";name=value" parameters are followed by the colon that starts the credential ("host/app;jsessionid=AB12:alice:Secret1"; but
 * "host/login;user=alice;Secret1" stays url;login;password). The semicolon is part of the url then, not the field separator.
 */
export function isUrlPathParameter(line: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^;\s]*;[A-Za-z_][\w-]*=/.test(line)
    || /^[\w-]+(?:\.[\w-]+)+(?::\d{1,5})?\/[^;\s]*(?:;[A-Za-z_][\w-]*=[^;:\s]*)+:/.test(line)
}

const WHITESPACE = /\s/

/**
 * `s.replace(/\s*:$/, '')` -- a final colon and the white space in front of it -- in linear time. The regex starts again at every position of a run of white space, so
 * a run of n characters in the middle of a line costs n*n steps (a line of 400,000 spaces and a pipe held the importer's thread for minutes). `\s` is a set of single UTF-16
 * code units, so testing them one by one gives the same cut.
 */
export function stripTrailingColon(s: string): string {
  if (!s.endsWith(':')) return s
  let end = s.length - 1
  while (end > 0 && WHITESPACE.test(s[end - 1])) end--
  return s.slice(0, end)
}

/**
 * `s.replace(/;+\s*$/, '')` -- a final run of semicolons and the white space behind it -- in linear time. The regex starts again at every semicolon of a run, so a run of
 * n semicolons costs n*n steps. When no semicolon stands directly in front of the trailing white space the string is returned as it is, like the regex does when it finds no match.
 */
export function stripTrailingSemicolons(s: string): string {
  let end = s.length
  while (end > 0 && WHITESPACE.test(s[end - 1])) end--
  let start = end
  while (start > 0 && s[start - 1] === ';') start--
  return start < end ? s.slice(0, start) : s
}

/** Which layout of a pipe joining a url and a credential was read (rule F: only the scheme; G: a one-word label; H: a url). */
export interface PipeJoin { kind: 'scheme' | 'label' | 'url'; line: string }

/**
 * Some lists put the pipe where a colon belongs: "https://| host:login:password" (only the scheme in front of it), "Network:| host:login:password" (a one-word
 * label), "https://host/path:| login:password", "https://host/path |:login:password" and "https://host/path|login:password" (a url, then the credential).
 * parseLine used to read that pipe as the login/password separator and stored the scheme, the label or the url as the login. Returns the layout and the line to
 * parse instead (the pipe removed, the url and the credential joined by a colon), or null when the pipe is something else: login|password, url|login|password, a
 * credential followed by a note. parseLine calls this only where it would otherwise have read the pipe as the field separator.
 */
export function pipeJoin(line: string): PipeJoin | null {
  const i = line.indexOf('|')
  if (i <= 0) return null
  const before = line.slice(0, i).trim()
  const rest = line.slice(i + 1).trim()
  if (!rest) return null
  const part = rest.split('|')[0].replace(/^:\s*/, '').trim()   // the first piece behind the pipe, without the colon that may lead it

  // F: only the scheme in front of the pipe. A login (an e-mail address, or a bare word) right behind it has no host to join with.
  if (SCHEME_ONLY.test(before)) {
    const first = rest.split(':')[0]
    return { kind: 'scheme', line: /[./]/.test(first) && !first.includes('@') ? before + rest : rest }
  }
  // G: a one-word label and a colon: the label is not part of the credential behind it.
  if (ONE_WORD_LABEL.test(before)) return CREDENTIAL_LINE.test(part.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')) ? { kind: 'label', line: rest } : null
  // H: a url, then the pipe, then "login:password". A bare host needs the colon in front of the pipe (without it "john.smith|pa:ss" is a login and a password).
  const urlPart = stripTrailingColon(before)
  const urlLike = SCHEME_URL.test(urlPart) || (before.endsWith(':') && BARE_HOST.test(urlPart))
  if (urlLike && LOGIN_PASSWORD.test(part)) return { kind: 'url', line: `${urlPart}:${part}` }
  return null
}

/**
 * pipeJoin, tried only where parseLine would otherwise have read the pipe as the login/password separator: no tab or semicolon in the line (those are the primary
 * separator and the pipe is noise), fewer than two colons in front of the pipe (two or more mean the credential is already in front of it and the rest is a
 * note), and no e-mail address and colon in front of it ("alice@mail.test:Secret1 | Country: US").
 */
export function joinPipedUrl(trimmed: string): PipeJoin | null {
  if (!trimmed.includes('|') || trimmed.startsWith('|') || trimmed.includes('\t') || trimmed.includes(';')) return null
  if (holdsCredential(trimmed.slice(0, trimmed.indexOf('|')))) return null
  return pipeJoin(trimmed)
}

/** The line after every join has been applied (parseLine goes on until none applies: "https://| host/path:|:login:pass" has two) and the layout of the first. */
export function pipeJoinAll(trimmed: string): PipeJoin | null {
  const base = protocolRelativeToPlain(trimmed) ?? trimmed   // "//host/path|login:pass" is read as the scheme-less line behind the slashes (rule E)
  const first = joinPipedUrl(base)
  if (!first) return null
  let line = first.line
  for (let i = 0; i < 4; i++) {
    const next = joinPipedUrl(line.trim())
    if (!next) break
    line = next.line
  }
  return { kind: first.kind, line }
}

// ─── Parser v6.2: four layouts the ingest quality gate caught in real files ──────────────────────────────────────────────────────────────────────────
// (docs/superpowers/specs/2026-10-24-parser-v6-2-and-gate-noise-design.md.) These are NEW functions on purpose: scripts/parser-diff.ts runs the previous parser against the
// helpers of the working tree, so an old helper changed in place would change the baseline too and hide its own effect.

const LEADING_COLONS_BEFORE_SCHEME = /^:+(?=[a-z][a-z0-9+.-]{0,31}:\/\/)/i

/**
 * ":https://shop.example.test/login:alice:Secret1": some lists put a colon (an empty first field) in front of every url. The importer kept it, so the url read
 * ":https://...", the scheme and host columns (url_scheme, url_host) came out wrong and the content key never matched the same credential from another file.
 * Returns the line without the colons, or the line itself when it does not start with colons and a scheme. Cheap on the usual line: one character is tested first.
 */
export function stripLeadingColonBeforeScheme(trimmed: string): string {
  if (trimmed.charCodeAt(0) !== 58) return trimmed
  const m = LEADING_COLONS_BEFORE_SCHEME.exec(trimmed)
  return m ? trimmed.slice(m[0].length) : trimmed
}

/** What a url that ends a line may look like behind its scheme: a host, an optional port, an optional path, and no other colon. */
const URL_LAST_TAIL = /^[^/:\s]+(?::\d{1,5})?(?:\/[^:\s]*)?$/
/** The same behind a semicolon: the semicolon already ends the login;password pair, so a colon in the path or the query is part of the url. */
const URL_AFTER_SEMICOLON_TAIL = /^[^/\s]+(?:\/\S*)?$/

/**
 * "alice;Secret1:https://shop.example.test/login" and "alice;Secret1;https://shop.example.test/login": login;password with the url last, behind a colon or a semicolon.
 * parseLine split such a line on its semicolons and left the url at the end of the password (or read the login as the url). Like splitLoginPasswordUrl (the colon form of the
 * same layout) it needs an http(s) url that ends the line and holds no colon but its port, a login without white space, a slash or a colon, and something on both sides of the
 * first semicolon. The password may hold colons and semicolons. Returns [url, login, password].
 */
export function splitSemicolonPasswordUrl(line: string): [string, string, string] | null {
  const schemeIdx = line.lastIndexOf('://')
  if (schemeIdx <= 0) return null
  const head = line.slice(0, schemeIdx)                          // "alice;Secret1:https" or "alice;Secret1;https"
  const urlSep = Math.max(head.lastIndexOf(':'), head.lastIndexOf(';'))
  if (urlSep <= 0 || !/^https?$/i.test(head.slice(urlSep + 1))) return null
  if (!(head[urlSep] === ';' ? URL_AFTER_SEMICOLON_TAIL : URL_LAST_TAIL).test(line.slice(schemeIdx + 3))) return null
  const fields = head.slice(0, urlSep)                           // "alice;Secret1"
  const semi = fields.indexOf(';')
  if (semi <= 0 || semi === fields.length - 1) return null
  const login = fields.slice(0, semi)
  if (/[\s/:]/.test(login)) return null
  return [line.slice(urlSep + 1), login, fields.slice(semi + 1)]
}

const LOGIN_LABELS: ReadonlySet<string> = new Set(['login', 'username', 'user', 'email', 'e-mail', 'mail'])
const PASSWORD_LABELS: ReadonlySet<string> = new Set(['password', 'pass', 'pwd'])

/**
 * "shop.example.test/|Username:alice:Password:Secret1": a url (with or without a scheme), a pipe, and a labelled pair. parseLine took the pipe for the login/password
 * separator: the host ended up as the login and "Username:alice:Password:Secret1" as the password (and with a scheme, the first label as the login). The first label must be
 * a login word and the second a password word (the same vocabulary as the labelled blocks), the login and the password must not be empty, and the password may hold anything.
 * Returns [url, login, password].
 */
export function splitPipedLabelledPair(trimmed: string): [string, string, string] | null {
  const bar = trimmed.indexOf('|')
  if (bar <= 0) return null
  const head = trimmed.slice(0, bar).trim()
  if (!SCHEME_URL.test(head) && !BARE_HOST.test(head)) return null
  const rest = trimmed.slice(bar + 1).trim()
  const first = rest.indexOf(':')
  if (first <= 0 || !LOGIN_LABELS.has(rest.slice(0, first).toLowerCase())) return null
  for (let p = rest.indexOf(':', first + 1); p !== -1; p = rest.indexOf(':', p + 1)) {
    const q = rest.indexOf(':', p + 1)
    if (q === -1) return null
    if (!PASSWORD_LABELS.has(rest.slice(p + 1, q).toLowerCase())) continue
    const login = rest.slice(first + 1, p)
    const password = rest.slice(q + 1)
    return login !== '' && password !== '' ? [head, login, password] : null
  }
  return null
}

/** True when the line holds a second "scheme://" behind the first: a url inside a url (rule M reads such a line differently; scripts/parser-diff.ts names the change by it). */
export function hasInnerScheme(line: string): boolean {
  const first = line.indexOf('://')
  return first !== -1 && line.indexOf('://', first + 3) !== -1
}

// ─── A rejected line that carries no credential (the gate's "unsplit" count) ───────────────────────────────────────────────────────────────────────

const SCHEME_LED = /^[a-z][a-z0-9+.-]*:\/\//i
const HOST_PATH_LED = /^[\w-]+(?:\.[\w-]+)+(?::\d{1,5})?\//
const HAS_SEPARATOR = /[:;|\t@]/
const HAS_SYMBOL = /\p{So}/u
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
/** A rejected line longer than this is counted as a possible credential: it is not a banner, and the check below should stay cheap. */
const NO_CREDENTIAL_MAX_LENGTH = 4096

/** A port: one to five digits that end the line or are followed by a slash, a colon, a query or a fragment. */
function portAt(s: string, from: number): boolean {
  let j = from
  while (j < s.length && j - from < 5 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++
  if (j === from) return false
  if (j === s.length) return true
  const next = s.charCodeAt(j)
  return next === 47 || next === 58 || next === 63 || next === 35
}

/** Field separators of a line: colons that are not part of a "://" or a port, semicolons, pipes and tabs. */
function fieldSeparators(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 58) {
      if (s.charCodeAt(i + 1) === 47 && s.charCodeAt(i + 2) === 47) { i += 2; continue }   // the "://" of a scheme, or of a url inside a url
      if (portAt(s, i + 1)) continue
      n++
    } else if (c === 59 || c === 124 || c === 9) n++
  }
  return n
}

/** An e-mail address as a token of the line: the line is cut at white space and at the characters that may stand beside it. */
function hasEmailToken(s: string): boolean {
  if (!s.includes('@')) return false
  for (const token of s.split(/[\s:;|/,]+/)) if (EMAIL_SHAPE.test(token)) return true
  return false
}

/**
 * A line the parser rejected that cannot be a credential in any layout it knows, so it says nothing about whether the parser reads the file well: a banner or a divider
 * (no field separator at all, and an emoji or symbol in it, or nothing but punctuation), a bare url, or a url (or host and path) with at most one field behind it ("https://host:8443:token",
 * "https://host/login?next=https://other/home:token"). It is false for anything that could be a credential the parser failed to split: plain text, a line with an e-mail address, a
 * line with two or more separators behind the url, any line with a separator that does not start with a url. The quality gate does not count the true ones as "unsplit".
 */
export function cannotHoldCredential(line: string): boolean {
  const t = stripLeadingColonBeforeScheme(line.trim())
  if (t.length > NO_CREDENTIAL_MAX_LENGTH) return false
  if (SCHEME_LED.test(t) || HOST_PATH_LED.test(t)) return !hasEmailToken(t) && fieldSeparators(t) < 2
  if (HAS_SEPARATOR.test(t)) return false
  return HAS_SYMBOL.test(t) || !HAS_LETTER_OR_DIGIT.test(t)
}
