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

export type RejectionReason = 'blank' | 'no_fields' | 'no_password'

export interface ParseResult {
  credentials:         ULPCredential[]
  skipped:             number
  errors:              number
  rejection_breakdown: Record<string, number>
}

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
      if (!state.login || !state.password) breakdown.no_fields++
      else breakdown.no_password++
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
  let   batchBreakdown: Record<RejectionReason, number> = { blank: 0, no_fields: 0, no_password: 0 }
  let   state   = makeBlockState()

  function flushBatch(): StreamBatch {
    const out: StreamBatch = { credentials: batch, rejected: batchRejected, breakdown: batchBreakdown }
    batch = []; batchRejected = 0
    batchBreakdown = { blank: 0, no_fields: 0, no_password: 0 }
    return out
  }

  function tryFlushBlock() {
    const cred = flushBlockState(state, filename)
    if (cred) {
      batch.push(cred)
    } else if (state.url || state.login || state.password) {
      batchRejected++
      if (!state.login || !state.password) batchBreakdown.no_fields++
      else batchBreakdown.no_password++
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

  // Percent-decode URL-encoded password (some stealers encode special chars)
  if (password.includes('%')) {
    try { password = decodeURIComponent(password) } catch { /* keep original if malformed */ }
  }

  // Rule 3: validation
  if (!login)                           return { credential: null, reason: 'no_fields' }
  if (!password || password.length < 3) return { credential: null, reason: 'no_password' }
  if (login === password)               return { credential: null, reason: 'no_password' }

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
  return { blank: 0, no_fields: 0, no_password: 0 }
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

  function tryFlushBlock() {
    const cred = flushBlockState(blockState, sourceFile)
    if (cred) {
      credentials.push(cred)
    } else if (blockState.url || blockState.login || blockState.password) {
      skipped++
      if (!blockState.login || !blockState.password) breakdown.no_fields++
      else breakdown.no_password++
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
      const domain = extractDomain(positionalUrl)
      credentials.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: sourceFile })
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
      credentials.push(credential)
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
  let   batchBreakdown: Record<RejectionReason, number> = { blank: 0, no_fields: 0, no_password: 0 }
  let   blockState = makeBlockState()
  // Positional (label-free) state — mirrors the same logic in parseULPContent
  let   positionalUrl   = ''
  let   positionalLogin = ''

  function flushBatch(): StreamBatch {
    const out: StreamBatch = { credentials: batch, rejected: batchRejected, breakdown: batchBreakdown }
    batch = []; batchRejected = 0
    batchBreakdown = { blank: 0, no_fields: 0, no_password: 0 }
    return out
  }

  function tryFlushBlock() {
    const cred = flushBlockState(blockState, filename)
    if (cred) {
      batch.push(cred)
    } else if (blockState.url || blockState.login || blockState.password) {
      batchRejected++
      if (!blockState.login || !blockState.password) batchBreakdown.no_fields++
      else batchBreakdown.no_password++
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
      const domain = extractDomain(positionalUrl)
      batch.push({ url: positionalUrl, email: positionalLogin, password: trimmed, domain, source_file: filename })
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
      batch.push(credential)
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
