/**
 * ULP credential line parser — v5
 *
 * Design: one algorithm, no regex in the hot path, RFC 3986-correct
 * colon disambiguation. ~150 lines for a format that is field:field:field.
 *
 * Algorithm:
 *  1. Skip blank / comment / section-header / android:// lines
 *  2. Strip trailing pipe-separated noise
 *  3. Separator detection: \t → ; → colon (priority)
 *  4. Colon-split with URL boundary + port stripping (RFC 3986)
 *  5. Field assignment: [url, login, pass] or ['', login, pass]
 *  6. Validation: 5 rules only
 *  7. Domain extraction: host between :// and next / or :, port stripped,
 *     www. prefix stripped
 */

export interface ULPCredential {
  url:         string
  email:       string
  password:    string
  domain:      string
  source_file: string
}

export type RejectionReason = 'blank' | 'no_fields' | 'no_password' | 'dedup' | 'garbage'

export interface ParseResult {
  credentials:         ULPCredential[]
  skipped:             number
  errors:              number
  rejection_breakdown: Record<string, number>
}

/**
 * Maximum size (bytes) a single buffered "line" may reach before the
 * streaming parsers (parseULPStream, parseBlockStream) force-flush it, even
 * with no '\n' found yet.
 *
 * Without this cap, a long run of non-text data (no '\n' for hundreds of MB —
 * e.g. an embedded binary blob in an otherwise-text file) makes `buffer +=
 * chunk` grow unboundedly while `buffer.split('\n')` re-scans the entire
 * (growing) buffer on every ~64KB read — O(n^2) — and once `buffer`
 * approaches V8's ~512MB-1GB string limit, the `+=` itself throws
 * "RangeError: Invalid string length", aborting the whole stream. Observed in
 * production: a 1.9GB inbox file crashed with exactly this error after 20+
 * minutes, having imported 0 rows.
 *
 * 1 MB is far larger than any real credential line (<1 KB) but keeps both the
 * buffer and the per-iteration split() cost bounded — the oversized chunk is
 * rejected like any other malformed line, and parsing continues normally with
 * whatever follows it.
 */
const MAX_LINE_LENGTH = 1 << 20 // 1 MB

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip a trailing port (`:digits`) from a hostname. */
function stripPort(host: string): string {
  const m = host.match(/^(.*):(\d+)$/)
  return m ? m[1] : host
}

/**
 * Extract the domain/host from a URL string.
 * Strips www. prefix for consistency with the old parser.
 */
export function extractDomain(url: string): string {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd !== -1) {
    const afterScheme = url.slice(schemeEnd + 3)
    const slashPos    = afterScheme.indexOf('/')
    const host        = slashPos === -1 ? afterScheme : afterScheme.slice(0, slashPos)
    return stripPort(host).toLowerCase().replace(/^www\./, '')
  }
  // No scheme — bare domain like site.com/path
  if (url.includes('.')) {
    const slashPos = url.indexOf('/')
    const host     = slashPos === -1 ? url : url.slice(0, slashPos)
    return stripPort(host).toLowerCase().replace(/^www\./, '')
  }
  return ''
}

/**
 * Control characters (excluding tab/newline/CR) plus the Unicode replacement
 * character U+FFFD. Neither ever appears in a legitimate credential: control
 * bytes mean binary/non-text source data, and U+FFFD means invalid UTF-8 bytes
 * were decoded (a mis-encoded or corrupted file). International text — Cyrillic,
 * Thai, Arabic, emoji, etc. — consists of valid codepoints and is NOT matched.
 */
function hasBinaryOrReplacement(s: string): boolean {
  // Double-encoded U+FFFD: the streaming parsers decode bytes with
  // Buffer.toString('latin1'), so a real replacement char (UTF-8 EF BF BD)
  // appears as the 3-char sequence U+00EF U+00BF U+00BD ("ï¿½"), never as
  // codepoint 0xFFFD. Those bytes only exist after a decoder already gave up
  // on invalid input, so they are always a corruption signal.
  if (s.includes('ï¿½')) return true
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // control chars except tab(9)/LF(10)/CR(13), or U+FFFD replacement char
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xFFFD) return true
  }
  return false
}

/**
 * A plausible hostname: dot-separated labels of letters/digits/hyphen, at least
 * one dot, labels not starting/ending with a hyphen. Unicode letters are
 * allowed (\p{L}) so IDN domains like "münchen.de" pass; only the *structure*
 * is checked. `extractDomain` has already lowercased the host and stripped port
 * and leading "www.". Any userinfo ("user@") is stripped before the check.
 *
 * Rejects the nonsense hosts the parser otherwise manufactures from binary junk
 * that contains "https://" — "0z" (no dot), "" (from "https:////..."), and
 * mojibake hosts (which carry symbols/punctuation/spaces that aren't \p{L}/
 * \p{N}/-/.) — while accepting real domains, IPv4, and basic-auth URLs.
 */
function isValidHost(host: string): boolean {
  const h = host.includes('@') ? host.slice(host.lastIndexOf('@') + 1) : host
  return /^[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?(\.[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?)+$/u.test(h)
}

/**
 * Logins that are export placeholders, never a real identity — Chrome/stealer
 * dumps emit these when no username was captured (password-reset pages, etc.).
 * Checked case-insensitively, on the login field only (so a weak real PASSWORD
 * like "password" is unaffected). NB: "user"/"username" are deliberately NOT
 * listed — they are common REAL logins (router/admin panels, default accounts),
 * so rejecting them caused false positives. The template tokens ({mail},{email})
 * and unknown/false/missing-user/pass are export/serialization placeholders;
 * "pass"/"false" carry a small real-username risk, accepted as a net win against
 * ~117k junk rows.
 */
const PLACEHOLDER_LOGINS = new Set([
  'password', 'n/a', 'na', 'none', 'null', 'undefined', '[not_saved]', 'not_saved',
  'unknown', '{mail}', '{email}', 'false', 'missing-user', 'pass',
])
function isPlaceholderLogin(login: string): boolean {
  return PLACEHOLDER_LOGINS.has(login.trim().toLowerCase())
}

/**
 * Passwords that are "no password could be extracted" sentinels, not real
 * secrets — browser "password not saved" markers ([NOT_SAVED], *none*, none),
 * extraction failures ([fail], [empty], [fetch_error]) and decryption failures
 * (Decryptionfailed., "Old or unknown version."). Exact match (trimmed,
 * case-insensitive) so a real password merely CONTAINING one of these as a
 * substring (e.g. "none123") is unaffected.
 */
const SENTINEL_PASSWORDS = new Set([
  '[not_saved]', 'not_saved', '*none*', 'none', '[fail]',
  'decryptionfailed.', 'old or unknown version.',
  '[empty]', '*empty*', '[fetch_error]',
])
function isSentinelPassword(password: string): boolean {
  return SENTINEL_PASSWORDS.has(password.trim().toLowerCase())
}

/**
 * Token / decryption blobs that never appear in a real login or password:
 * Google GAIA recovery tokens (gmail_ps=, gmail=), digit-corrupted android
 * token glue (==@com.), and AES/hex decryption failures ([Wrong padding]).
 * Note: legit "android://HASH==@com.pkg" carries "==@com." in the URL field,
 * which is never passed here — only login/password are checked.
 */
function hasJunkMarker(s: string): boolean {
  return s.includes('gmail_ps=') || s.includes('gmail=')
      || s.includes('==@com.')   || s.includes('[Wrong padding]')
}

/**
 * Finalize-time junk gate, bundling every reject rule that applies to a built
 * credential: placeholder login, sentinel password, token/decryption marker,
 * and binary/mojibake. Called from credential-emission sites that don't
 * otherwise run these checks (block + positional). `parseLine` runs the binary
 * check inline already.
 */
function isJunkCredential(login: string, password: string): boolean {
  return isPlaceholderLogin(login)     || isSentinelPassword(password)
      || hasJunkMarker(login)          || hasJunkMarker(password)
      || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)
}

// ── Block-format parser (Raccoon / Stealc / Meta / Vidar style) ──────────────

export type BlockField = 'url' | 'login' | 'password' | 'soft'

export interface BlockState {
  url:      string
  login:    string
  password: string
}

const BLOCK_URL_LABELS   = new Set(['host', 'url', 'hostname', 'ur1', 'link', 'site'])
const BLOCK_LOGIN_LABELS = new Set(['login', 'username', 'user', 'email', 'e-mail', 'user login', 'u53rn4m3'])
const BLOCK_PASS_LABELS  = new Set(['password', 'pass', 'pwd', 'user password'])
const BLOCK_SOFT_LABELS  = new Set(['soft', 'application', 'browser', 'app', 'storage', 'software'])

/**
 * If `trimmed` is a labeled block field (e.g. "Host: https://..."), return its
 * field type and value.  Matching is case-insensitive on the label.
 * Returns null for non-labeled lines.
 */
export function classifyBlockLabel(
  trimmed: string,
): { field: BlockField; value: string } | null {
  const colon = trimmed.indexOf(':')
  if (colon === -1) return null
  const label = trimmed.slice(0, colon).trim().toLowerCase()
  const value = trimmed.slice(colon + 1).trim()
  if (BLOCK_URL_LABELS.has(label))   return { field: 'url',      value }
  if (BLOCK_LOGIN_LABELS.has(label)) return { field: 'login',    value }
  if (BLOCK_PASS_LABELS.has(label))  return { field: 'password', value }
  if (BLOCK_SOFT_LABELS.has(label))  return { field: 'soft',     value }
  return null
}

/**
 * Returns true if this line signals end-of-block:
 * blank line, or a run of 3+ identical separator characters (=, -, >).
 */
export function isBlockSeparator(trimmed: string): boolean {
  if (!trimmed) return true
  return trimmed.length >= 3 && /^[=\->]{3,}$/.test(trimmed)
}

/** Returns a fresh empty BlockState. */
export function makeBlockState(): BlockState {
  return { url: '', login: '', password: '' }
}

/**
 * Flush `state` into a ULPCredential if it satisfies validation rules.
 * Returns null if login is empty, password is absent/too-short, or login===password.
 */
export function flushBlockState(
  state: BlockState,
  sourceFile: string,
): ULPCredential | null {
  const { url, login, password } = state
  if (!login)                           return null
  if (!password || password.length < 3) return null
  if (login === password)               return null
  if (isJunkCredential(login, password)) return null
  const domain = url
    ? extractDomain(url)
    : (login.includes('@') ? login.split('@').pop()!.toLowerCase() : '')
  return { url, email: login, password, domain, source_file: sourceFile }
}

/**
 * Process one line against a mutable BlockState.
 *
 * - 'field'     — line was a labeled field; state has been updated.
 * - 'separator' — line is a block separator; caller should flush state.
 * - 'ignored'   — line was neither a label nor a separator.
 */
export function parseBlockLine(
  line:  string,
  state: BlockState,
): 'field' | 'separator' | 'ignored' {
  const trimmed = line.trim()
  const labeled = classifyBlockLabel(trimmed)
  if (labeled) {
    if (labeled.field === 'url')      state.url      = labeled.value
    if (labeled.field === 'login')    state.login    = labeled.value
    if (labeled.field === 'password') state.password = labeled.value
    // 'soft' is metadata — intentionally not stored
    return 'field'
  }
  if (isBlockSeparator(trimmed)) return 'separator'
  return 'ignored'
}

/** Parse a string of pure block-format content. */
export function parseBlockContent(content: string, sourceFile: string): ParseResult {
  const lines       = content.split('\n')
  const credentials: ULPCredential[] = []
  const breakdown   = makeRejectionMap()
  let   skipped     = 0
  let   state       = makeBlockState()

  function tryFlush() {
    const cred = flushBlockState(state, sourceFile)
    if (cred) {
      credentials.push(cred)
    } else if (state.url || state.login || state.password) {
      skipped++
      // Classify: if no login found at all → no_fields; otherwise the credential
      // had a login but was rejected for a password reason (missing / too-short /
      // equals login) → no_password.
      if (!state.login)                                       breakdown.no_fields++
      else if (isJunkCredential(state.login, state.password)) breakdown.garbage++
      else                                                    breakdown.no_password++
    }
    state = makeBlockState()
  }

  for (const line of lines) {
    const result = parseBlockLine(line, state)
    if (result === 'separator') tryFlush()
    // 'field' and 'ignored' — state already updated or line irrelevant
  }
  tryFlush()  // flush final block

  return { credentials, skipped, errors: 0, rejection_breakdown: breakdown }
}

/** Streaming block-format parser — yields batches of credentials. */
export async function* parseBlockStream(
  stream:    ReadableStream<Uint8Array>,
  filename:  string,
  batchSize: number,
): AsyncGenerator<StreamBatch> {
  const reader  = stream.getReader()
  // Use Buffer.from(chunk).toString('latin1') — NOT TextDecoder.
  //
  // TextDecoder('latin1') is a WHATWG alias for windows-1252.  Windows-1252 has
  // 5 undefined byte positions (0x81, 0x8D, 0x8F, 0x90, 0x9D) that cause
  // ERR_ENCODING_INVALID_ENCODED_DATA even with fatal:false in streaming mode
  // (Node.js issues #26115, #56219, #59515).  Node.js also regressed
  // windows-1252 decoding in v23.4.0+.
  //
  // Node.js Buffer.toString('latin1') uses true ISO-8859-1 — a direct bijective
  // map of all 256 byte values to Unicode U+0000–U+00FF.  It never throws and
  // never produces replacement characters regardless of the byte sequence.
  let   buffer  = ''
  let   batch:  ULPCredential[] = []
  let   batchRejected = 0
  let   batchBreakdown: Record<RejectionReason, number> = { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
  let   state   = makeBlockState()

  function flushBatch(): StreamBatch {
    const out: StreamBatch = { credentials: batch, rejected: batchRejected, breakdown: batchBreakdown }
    batch = []; batchRejected = 0
    batchBreakdown = { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
    return out
  }

  function tryFlushBlock() {
    const cred = flushBlockState(state, filename)
    if (cred) {
      batch.push(cred)
    } else if (state.url || state.login || state.password) {
      batchRejected++
      // no login at all → no_fields; login present but password issue → no_password
      if (!state.login)                                       batchBreakdown.no_fields++
      else if (isJunkCredential(state.login, state.password)) batchBreakdown.garbage++
      else                                                    batchBreakdown.no_password++
    }
    state = makeBlockState()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Slice large chunks to stay under V8's 512 MB string limit.
      // file.stream() on an in-memory File (from formData()) can yield the
      // entire file as one Uint8Array; decoding >512 MB at once throws
      // ERR_STRING_TOO_LONG.  4 MB slices keep each toString() call tiny.
      const SLICE = 1 << 22 // 4 MB
      for (let off = 0; off < value.length; off += SLICE) {
        buffer += Buffer.from(value.subarray(off, Math.min(off + SLICE, value.length))).toString('latin1')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const result = parseBlockLine(line, state)
          if (result === 'separator') {
            tryFlushBlock()
            if (batch.length >= batchSize) yield flushBatch()
          }
        }

        // No '\n' found (or a huge trailing partial line) — force-flush so
        // buffer can't grow unboundedly. See MAX_LINE_LENGTH.
        if (buffer.length > MAX_LINE_LENGTH) {
          const result = parseBlockLine(buffer, state)
          buffer = ''
          if (result === 'separator') {
            tryFlushBlock()
            if (batch.length >= batchSize) yield flushBatch()
          }
        }
      }
    }
    if (buffer) {
      const result = parseBlockLine(buffer, state)
      if (result === 'separator') tryFlushBlock()
    }
    tryFlushBlock()  // flush final incomplete block
    if (batch.length > 0 || batchRejected > 0) yield flushBatch()
  } finally {
    reader.releaseLock()
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a colon-delimited ULP line into [url, login, password].
 *
 * RFC 3986 rules applied:
 *  - If line contains `://`, the URL ends at the first `/` after the scheme.
 *    Ports (`:digits` immediately after host) are absorbed into the URL field.
 *  - If no scheme, treat first two colons as separators; remainder is password.
 *    For 2-field lines (email:pass), the url slot is set to '' to signal no URL.
 */
function colonSplit(line: string): [string, string, string] | null {
  const schemeIdx = line.indexOf('://')
  if (schemeIdx !== -1) {
    // Find first slash after "://"
    const afterScheme = schemeIdx + 3
    const slashIdx    = line.indexOf('/', afterScheme)
    if (slashIdx !== -1) {
      // URL is everything up to and including the slash (absorbs port in host)
      const urlPart   = line.slice(0, slashIdx)
      const rest      = line.slice(slashIdx + 1)            // path:login:pass
      const colon1    = rest.indexOf(':')
      if (colon1 === -1) return null                        // no login separator
      const fullUrl   = urlPart + '/' + rest.slice(0, colon1)
      const loginRest = rest.slice(colon1 + 1)             // "login:pass" or "login"
      const colon2    = loginRest.indexOf(':')
      if (colon2 === -1) return null                        // no password
      return [fullUrl, loginRest.slice(0, colon2), loginRest.slice(colon2 + 1)]
    } else {
      // No path — URL is up to end of host:port, then colon separates login
      // e.g. "https://site.com:8443:user:pass"
      const hostStart = afterScheme
      // Consume optional port (digits after colon)
      const portMatch = line.slice(hostStart).match(/^([^:]+):(\d+):/)
      let loginStart: number
      if (portMatch) {
        loginStart = hostStart + portMatch[0].length
      } else {
        const c = line.indexOf(':', hostStart)
        if (c === -1) return null
        loginStart = c + 1
      }
      const urlPart   = line.slice(0, loginStart - 1)
      const loginRest = line.slice(loginStart)
      const colon     = loginRest.indexOf(':')
      if (colon === -1) return null
      return [urlPart, loginRest.slice(0, colon), loginRest.slice(colon + 1)]
    }
  }

  // No scheme — split on first two colons; rest is password.
  // Special case: if the first segment contains '@', it's an email address
  // (login:password format), so only split at the first colon.
  const c1 = line.indexOf(':')
  if (c1 === -1) return null
  const left = line.slice(0, c1)

  // Email login: "user@domain.com:password" → ['', email, password]
  if (left.includes('@')) {
    return ['', left, line.slice(c1 + 1)]
  }

  const c2 = line.indexOf(':', c1 + 1)
  if (c2 === -1) {
    // 2-field line: "login:password" — but if left contains '/' it is a
    // URL-path:username pattern (e.g. "site.com/login:Camerajake"), not a
    // credential.  Reject it so the URL doesn't land in the email column.
    if (left.includes('/')) return null
    // "login:password" — signal no-URL with empty string
    return ['', left, line.slice(c1 + 1)]
  }
  // Port / port+path leak: scheme-less "host:port[/path]:login:pass". The
  // segment between the first two colons is a port (digits, ≤65535) or a port
  // followed by a path — part of the URL, NOT the login. Absorb "host:mid" into
  // the URL and re-split the remainder as login:password. (e.g.
  // "localhost:10000/:admin:12345" → url="localhost:10000/", login="admin".)
  const mid = line.slice(c1 + 1, c2)
  const isPortPath = /^\d+\//.test(mid)
  const isBarePort = /^\d{1,5}$/.test(mid) && Number(mid) <= 65535
  if (isPortPath || isBarePort) {
    const rest = line.slice(c2 + 1)           // login:password (may have more colons)
    const rc   = rest.indexOf(':')
    // Only absorb the port when a real login:password follows it. If nothing
    // after the port contains a ':', this is a plain 3-field "host:login:pass"
    // with a numeric (or path-looking) login — fall through to the default
    // split below rather than dropping the row.
    if (rc !== -1) {
      return [left + ':' + mid, rest.slice(0, rc), rest.slice(rc + 1)]
    }
  }
  return [left, line.slice(c1 + 1, c2), line.slice(c2 + 1)]
}

// ── Core parse function ───────────────────────────────────────────────────────

export function parseLine(
  line: string,
  sourceFile: string,
): { credential: ULPCredential | null; reason: RejectionReason | null } {
  const trimmed = line.trim()

  // Rule 1: blank / comment / section header / // prefix
  // NOTE: android:// lines are intentionally NOT filtered here.  Android app
  // credentials in stealer logs have the form:
  //   android://hash@com.package.name:user@example.com:password
  // colonSplit handles the :// scheme and extracts the three fields correctly.
  if (!trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('//')) {
    return { credential: null, reason: 'blank' }
  }

  // Pipe separator detection:
  // If the line already uses tab or semicolon as its primary separator, pipe is
  // just noise (e.g. password field contains '|') — strip from first pipe.
  // Otherwise, if the segment before the first '|' has <2 non-scheme colons,
  // treat '|' as the primary field separator (combo-list: url|login|pass).
  // If it has 2+ non-scheme colons the credential is already embedded before
  // the pipe, so pipe marks trailing metadata — strip it.
  let clean: string
  if (trimmed.includes('|') && !trimmed.startsWith('|')) {
    if (trimmed.includes('\t') || trimmed.includes(';')) {
      // Tab or semicolon is primary separator → pipe is trailing noise
      clean = trimmed.split('|')[0].trim()
    } else {
      const beforePipe = trimmed.slice(0, trimmed.indexOf('|'))
      // Count colons that are NOT part of a '://' scheme
      const nonSchemeColons = (beforePipe.replace('://', '  ').match(/:/g) ?? []).length
      if (nonSchemeColons >= 2) {
        // Has login:pass embedded before the pipe → trailing metadata, strip it
        clean = beforePipe.trim()
      } else {
        // No embedded credential before the pipe → pipe IS the separator
        clean = trimmed
      }
    }
  } else {
    clean = trimmed
  }

  // Rule 2: separator detection (\t beats ; beats | beats :)
  let url = '', login = '', password = ''
  if (clean.includes('\t')) {
    const parts = clean.split('\t')
    if (parts.length >= 3) {
      url      = parts[0].trim()
      login    = parts[1].trim()
      password = parts.slice(2).join('\t').trim()
      // Monster-material blank-first-tab fix:
      // These files use the format  \t<URL>\t<credential>  (empty leading field).
      // The parser naively puts '' in url, the URL in login, and the raw
      // credential string in password.  Detect by: url='' and login has '/'.
      // Re-route: url ← login; split credential on its FIRST colon only
      // (the credential is always login:password, never url:login:password).
      if (url === '' && login.includes('/')) {
        url = login
        const colonPos = password.indexOf(':')
        if (colonPos === -1) return { credential: null, reason: 'no_fields' }
        const credLogin = password.slice(0, colonPos)
        const credPass  = password.slice(colonPos + 1)
        // If the extracted "login" is itself a URL path, the format is unrecognised → skip.
        if (credLogin.includes('/')) return { credential: null, reason: 'no_fields' }
        login    = credLogin
        password = credPass
      }
    } else if (parts.length === 2) {
      login    = parts[0].trim()
      password = parts[1].trim()
      // Monster-material blank-first-tab fix (2-field variant):
      // The leading \t is eaten by line.trim(), leaving a 2-field line where
      // parts[0] is the URL and parts[1] is the raw credential string.
      // Detect by: login contains '/' (URL path) and no '@' (not an email address).
      // Re-route: url ← login; split credential on first colon → new login:password.
      if (login.includes('/') && !login.includes('@')) {
        url = login
        const colonPos = password.indexOf(':')
        if (colonPos === -1) return { credential: null, reason: 'no_fields' }
        const credLogin = password.slice(0, colonPos)
        const credPass  = password.slice(colonPos + 1)
        if (credLogin.includes('/')) return { credential: null, reason: 'no_fields' }
        login    = credLogin
        password = credPass
      }
    } else {
      return { credential: null, reason: 'no_fields' }
    }
  } else if (clean.includes(';')) {
    const parts = clean.split(';')
    if (parts.length >= 3) {
      url      = parts[0].trim()
      login    = parts[1].trim()
      password = parts.slice(2).join(';').trim()
    } else if (parts.length === 2) {
      login    = parts[0].trim()
      password = parts[1].trim()
    } else {
      return { credential: null, reason: 'no_fields' }
    }
  } else if (clean.includes('|') && !clean.startsWith('|')) {
    // Pipe primary separator (set by the clean-assignment logic above)
    const parts = clean.split('|')
    if (parts.length >= 3) {
      url      = parts[0].trim()
      login    = parts[1].trim()
      password = parts.slice(2).join('|').trim()
    } else if (parts.length === 2) {
      login    = parts[0].trim()
      password = parts[1].trim()
    } else {
      return { credential: null, reason: 'no_fields' }
    }
  } else {
    const split = colonSplit(clean)
    if (!split) return { credential: null, reason: 'no_fields' }
    ;[url, login, password] = split
  }

  // Country-code URL prefix: some source files prepend an ISO country code +
  // space to the URL field ("DZ https://site/..."), which is not part of the
  // URL. Strip it so the stored `url` (and the url_host materialized from it)
  // are clean — not just NORM_COLS-repaired at display time. Gated on a scheme
  // immediately following the short token, so real paths like
  // "https://news.com/in/article" are never touched. extractDomain already
  // ignored the prefix, so `domain` is unaffected.
  if (/^[A-Za-z]{1,3}\s+https?:\/\//.test(url)) {
    url = url.replace(/^[A-Za-z]{1,3}\s+/, '')
  }

  // Percent-decode URL-encoded password (some stealers encode special chars)
  if (password.includes('%')) {
    try { password = decodeURIComponent(password) } catch { /* keep original if malformed */ }
  }

  // Rule 3: validation
  if (!login)                           return { credential: null, reason: 'no_fields' }
  if (!password || password.length < 3) return { credential: null, reason: 'no_password' }
  if (login === password)               return { credential: null, reason: 'no_password' }

  // Rule 3.5: binary / encoding-failure rejection. A control byte or a U+FFFD
  // replacement char in any field means the source line was binary or
  // mis-encoded, not a credential — colonSplit will still have produced
  // url/login/password from the junk. Drop it. (International text is unharmed.)
  if (hasBinaryOrReplacement(url) || hasBinaryOrReplacement(login) || hasBinaryOrReplacement(password)) {
    return { credential: null, reason: 'garbage' }
  }

  // Rule 3.6: garbage-URL rejection. colonSplit accepts ANY "https://XX:..." as
  // a credential, so binary/junk source data that merely contains "https://"
  // yields fake rows with nonsense hosts (https://0Z, https:////..., mojibake).
  // Only http(s) URLs are checked — that's where the junk concentrates; app
  // schemes (android://, etc.) and scheme-less hosts (localhost, plain words)
  // are left alone to avoid false positives. If the url is junk but the login
  // is a real email, salvage the row as an email:password pair (drop the url);
  // otherwise the whole line is junk.
  if (/^https?:\/\//i.test(url) && !isValidHost(extractDomain(url))) {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)) {
      url = ''
    } else {
      return { credential: null, reason: 'garbage' }
    }
  }

  // Rule 3.7: placeholder / sentinel / token-blob rejection. A login that is an
  // export placeholder (Password, N/A, [NOT_SAVED], ...) is not a real identity;
  // a sentinel password ([NOT_SAVED], *none*, Decryptionfailed., ...) means no
  // password was captured; gmail_ps=/gmail=/==@com./[Wrong padding] are token or
  // decryption junk. (Binary/mojibake already handled by Rule 3.5.)
  if (isPlaceholderLogin(login) || isSentinelPassword(password)
      || hasJunkMarker(login) || hasJunkMarker(password)) {
    return { credential: null, reason: 'garbage' }
  }

  // Rule 4: domain extraction
  const domain = url
    ? extractDomain(url)
    : (login.includes('@') ? login.split('@').pop()!.toLowerCase() : '')

  return {
    credential: { url, email: login, password, domain, source_file: sourceFile },
    reason: null,
  }
}

// ── Batch / stream parsers ────────────────────────────────────────────────────

export function makeRejectionMap(): Record<string, number> {
  return { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
}

export function parseULPContent(content: string, sourceFile: string): ParseResult {
  const lines       = content.split('\n')
  const credentials: ULPCredential[] = []
  const breakdown   = makeRejectionMap()
  let   skipped     = 0
  let   blockState  = makeBlockState()
  // Positional (label-free) state: tracks URL and login for 3-line stealer log blocks
  // e.g.  https://site.com/path  ← positionalUrl
  //       user@email.com          ← positionalLogin
  //       mypassword123           ← emit credential, reset
  let   positionalUrl   = ''
  let   positionalLogin = ''
  // Per-call dedup set — caps at SEEN_CAP to prevent OOM on huge files.
  // Beyond the cap, duplicates are allowed through and can be cleaned up later
  // via POST /api/admin/dedup (ClickHouse OPTIMIZE TABLE DEDUPLICATE).
  const SEEN_CAP = 2_000_000  // ~440 MB max heap for the Set
  const seen = new Set<string>()
  let seenCapWarned = false

  function addSeen(fp: string, filename: string): boolean {
    if (seen.size >= SEEN_CAP) {
      if (!seenCapWarned) {
        seenCapWarned = true
        console.warn(`[ulp-parser] dedup cap (${SEEN_CAP.toLocaleString()}) reached for ${filename}. ` +
          'Remaining rows skip in-file dedup — run POST /api/admin/dedup after import.')
      }
      return false  // not added; caller should push credential
    }
    seen.add(fp)
    return true
  }

  function tryFlushBlock() {
    const cred = flushBlockState(blockState, sourceFile)
    if (cred) {
      const fp = `${cred.url}\0${cred.email}\0${cred.password}`
      if (!seen.has(fp) && seen.size >= SEEN_CAP) { credentials.push(cred) }  // cap hit — allow
      else if (seen.has(fp)) { skipped++; breakdown.dedup++ }
      else { addSeen(fp, sourceFile); credentials.push(cred) }
    } else if (blockState.url || blockState.login || blockState.password) {
      skipped++
      if (!blockState.login)                                            breakdown.no_fields++
      else if (isJunkCredential(blockState.login, blockState.password)) breakdown.garbage++
      else                                                              breakdown.no_password++
    }
    blockState = makeBlockState()
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Block labeled field — intercept before inline parseLine to prevent false positives.
    // Entering labeled mode discards any in-progress positional state.
    const labeled = classifyBlockLabel(trimmed)
    if (labeled) {
      positionalUrl = positionalLogin = ''
      if (labeled.field === 'url')      blockState.url      = labeled.value
      if (labeled.field === 'login')    blockState.login    = labeled.value
      if (labeled.field === 'password') blockState.password = labeled.value
      continue
    }

    // Block separator — flush labeled block state if present; always reset positional state.
    if (isBlockSeparator(trimmed)) {
      positionalUrl = positionalLogin = ''
      if (blockState.url || blockState.login || blockState.password) {
        tryFlushBlock()
      } else {
        // Plain blank/separator line with no accumulated state → count as blank
        skipped++
        breakdown.blank++
      }
      continue
    }

    // Positional password: URL + login already collected → emit credential
    if (positionalUrl && positionalLogin) {
      if (isJunkCredential(positionalLogin, trimmed)) {
        skipped++; breakdown.garbage++
        positionalUrl = positionalLogin = ''
        continue
      }
      const fp = `${positionalUrl}\0${positionalLogin}\0${trimmed}`
      if (seen.has(fp)) {
        skipped++; breakdown.dedup++
      } else {
        const domain = extractDomain(positionalUrl)
        addSeen(fp, sourceFile)
        credentials.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: sourceFile })
      }
      positionalUrl = positionalLogin = ''
      continue
    }

    // Positional login: URL already collected, waiting for login on this line
    if (positionalUrl) {
      positionalLogin = trimmed
      continue
    }

    // Inline parseLine (non-labeled, non-separator, non-positional lines)
    const { credential, reason } = parseLine(line, sourceFile)
    if (credential) {
      const fp = `${credential.url}\0${credential.email}\0${credential.password}`
      if (seen.has(fp)) { skipped++; breakdown.dedup++ }
      else { addSeen(fp, sourceFile); credentials.push(credential) }
    } else if (reason === 'no_fields' && trimmed.startsWith('http')) {
      // Bare URL line → enter positional mode; next line is login, line after is password.
      // Not counted as skipped — will be consumed by positional collection or discarded at separator/EOF.
      positionalUrl   = trimmed
      positionalLogin = ''
    } else {
      skipped++
      if (reason && reason in breakdown) breakdown[reason]++
    }
  }

  // Discard any trailing incomplete positional block at EOF
  positionalUrl = positionalLogin = ''
  tryFlushBlock()  // flush any trailing incomplete labeled block at EOF

  return { credentials, skipped, errors: 0, rejection_breakdown: breakdown }
}

export interface StreamBatch {
  credentials: ULPCredential[]
  rejected:    number
  breakdown:   Record<RejectionReason, number>
}

export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
): AsyncGenerator<StreamBatch> {
  const reader  = stream.getReader()
  // Use Buffer.from(chunk).toString('latin1') — NOT TextDecoder.
  //
  // TextDecoder('latin1') is a WHATWG alias for windows-1252.  Windows-1252 has
  // 5 undefined byte positions (0x81, 0x8D, 0x8F, 0x90, 0x9D) that cause
  // ERR_ENCODING_INVALID_ENCODED_DATA even with fatal:false in streaming mode
  // (Node.js issues #26115, #56219, #59515).  Node.js also regressed
  // windows-1252 decoding in v23.4.0+.
  //
  // Node.js Buffer.toString('latin1') uses true ISO-8859-1 — a direct bijective
  // map of all 256 byte values to Unicode U+0000–U+00FF.  It never throws and
  // never produces replacement characters regardless of the byte sequence.
  let   buffer  = ''
  let   batch:  ULPCredential[] = []
  let   batchRejected = 0
  let   batchBreakdown: Record<RejectionReason, number> = { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
  let   blockState = makeBlockState()
  // Positional (label-free) state — mirrors the same logic in parseULPContent
  let   positionalUrl   = ''
  let   positionalLogin = ''
  // Per-upload dedup set — capped at STREAM_SEEN_CAP to prevent OOM on huge files.
  // At 2M entries × ~220 bytes = ~440 MB max heap cost.  Beyond the cap, dedup is
  // disabled for the remainder of the file.  Run POST /api/admin/dedup afterwards
  // to remove any duplicates ClickHouse received past the cap.
  const STREAM_SEEN_CAP = 2_000_000
  const seen = new Set<string>()
  let streamSeenCapWarned = false

  function flushBatch(): StreamBatch {
    const out: StreamBatch = { credentials: batch, rejected: batchRejected, breakdown: batchBreakdown }
    batch = []; batchRejected = 0
    batchBreakdown = { blank: 0, no_fields: 0, no_password: 0, dedup: 0, garbage: 0 }
    return out
  }

  // Cap-aware seen check for parseULPStream
  function streamSeenCheck(fp: string): boolean {
    // Returns true if credential should be skipped (duplicate)
    if (seen.size >= STREAM_SEEN_CAP) {
      if (!streamSeenCapWarned) {
        streamSeenCapWarned = true
        console.warn(`[ulp-parser] dedup cap (${STREAM_SEEN_CAP.toLocaleString()}) reached for ${filename}. ` +
          'Remaining rows skip in-file dedup — run POST /api/admin/dedup after import.')
      }
      return false  // cap hit — allow through (not a known duplicate)
    }
    if (seen.has(fp)) return true
    seen.add(fp)
    return false
  }

  function tryFlushBlock() {
    const cred = flushBlockState(blockState, filename)
    if (cred) {
      const fp = `${cred.url}\0${cred.email}\0${cred.password}`
      if (streamSeenCheck(fp)) { batchRejected++; batchBreakdown.dedup++ }
      else                     { batch.push(cred) }
    } else if (blockState.url || blockState.login || blockState.password) {
      batchRejected++
      // no login at all → no_fields; login present but password issue → no_password
      if (!blockState.login)                                            batchBreakdown.no_fields++
      else if (isJunkCredential(blockState.login, blockState.password)) batchBreakdown.garbage++
      else                                                              batchBreakdown.no_password++
    }
    blockState = makeBlockState()
  }

  function processLine(line: string) {
    const trimmed = line.trim()

    // Labeled field — discard any in-progress positional state, enter labeled mode
    const labeled = classifyBlockLabel(trimmed)
    if (labeled) {
      positionalUrl = positionalLogin = ''
      if (labeled.field === 'url')      blockState.url      = labeled.value
      if (labeled.field === 'login')    blockState.login    = labeled.value
      if (labeled.field === 'password') blockState.password = labeled.value
      return
    }

    // Separator — flush labeled block if present; always reset positional state
    if (isBlockSeparator(trimmed)) {
      positionalUrl = positionalLogin = ''
      if (blockState.url || blockState.login || blockState.password) {
        tryFlushBlock()
      } else {
        batchRejected++
        batchBreakdown.blank++
      }
      return
    }

    // Positional password: URL + login collected → emit credential
    if (positionalUrl && positionalLogin) {
      if (isJunkCredential(positionalLogin, trimmed)) {
        batchRejected++; batchBreakdown.garbage++
        positionalUrl = positionalLogin = ''
        return
      }
      const fp = `${positionalUrl}\0${positionalLogin}\0${trimmed}`
      if (streamSeenCheck(fp)) {
        batchRejected++; batchBreakdown.dedup++
      } else {
        const domain = extractDomain(positionalUrl)
        batch.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: filename })
      }
      positionalUrl = positionalLogin = ''
      return
    }

    // Positional login: URL collected, waiting for login
    if (positionalUrl) {
      positionalLogin = trimmed
      return
    }

    const { credential, reason } = parseLine(line, filename)
    if (credential) {
      const fp = `${credential.url}\0${credential.email}\0${credential.password}`
      if (streamSeenCheck(fp)) { batchRejected++; batchBreakdown.dedup++ }
      else                     { batch.push(credential) }
    } else if (reason === 'no_fields' && trimmed.startsWith('http')) {
      // Bare URL → enter positional mode
      positionalUrl   = trimmed
      positionalLogin = ''
    } else {
      batchRejected++
      if (reason) batchBreakdown[reason]++
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Slice large chunks to stay under V8's 512 MB string limit.
      // file.stream() on an in-memory File (from formData()) can yield the
      // entire file as one Uint8Array; decoding >512 MB at once throws
      // ERR_STRING_TOO_LONG.  4 MB slices keep each toString() call tiny.
      const SLICE = 1 << 22 // 4 MB
      for (let off = 0; off < value.length; off += SLICE) {
        buffer += Buffer.from(value.subarray(off, Math.min(off + SLICE, value.length))).toString('latin1')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          processLine(line)
          if (batch.length >= batchSize) yield flushBatch()
        }

        // No '\n' found (or a huge trailing partial line) — force-flush so
        // buffer can't grow unboundedly. See MAX_LINE_LENGTH.
        if (buffer.length > MAX_LINE_LENGTH) {
          processLine(buffer)
          buffer = ''
          if (batch.length >= batchSize) yield flushBatch()
        }
      }
    }
    if (buffer) processLine(buffer)
    positionalUrl = positionalLogin = ''  // discard trailing incomplete positional block
    tryFlushBlock()  // flush trailing labeled block at EOF
    if (batch.length > 0 || batchRejected > 0) yield flushBatch()
  } finally {
    reader.releaseLock()
  }
}
