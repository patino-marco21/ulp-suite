/**
 * Line layouts that parseLine used to reject and that parser v6 reads (docs/superpowers/specs/2026-10-12-parser-v6-and-redo-design.md). Each helper is pure and
 * returns null when the line is not of its shape. All of them are tried only AFTER the existing field split found nothing, except splitSpacePaddedColons:
 * the existing split returns white-space-padded fields for that shape, and the garbage gate then rejects them.
 */

/** Ports a web server really listens on: a number after the host that is one of these is a port, not a login (rule D). */
export const COMMON_WEB_PORTS: ReadonlySet<number> = new Set([
  80, 81, 82, 88, 443, 444, 591, 631, 2082, 2083, 2086, 2087, 2095, 2096, 3000, 3001, 3128, 3306, 4443, 5000, 5001, 5432, 5601, 7001, 7443,
  8000, 8001, 8008, 8010, 8080, 8081, 8082, 8083, 8088, 8090, 8181, 8443, 8444, 8480, 8888, 8889, 9000, 9001, 9090, 9091, 9200, 9443, 10000, 10443, 20000,
])

/**
 * A "password" that is really a piece of a URL: a scheme, a host name followed by a slash, a leading www., a query string, a web file extension, or three
 * or more slashes. Used by the slash-in-password and protocol-relative rules, where the extra slash can belong to a path instead of the password.
 */
export function looksLikeUrlFragment(password: string): boolean {
  return password.includes('://')
    || /^www\./i.test(password)
    || /^[\w-]+(\.[\w-]+)+\//.test(password)
    || /[?&][\w%.-]+=/.test(password)
    || /\.(php|aspx?|html?|jsp|cgi)(\b|$)/i.test(password)
    || (password.match(/\//g) ?? []).length >= 3
}

const PADDED_COLON = /\s+:\s+/
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
