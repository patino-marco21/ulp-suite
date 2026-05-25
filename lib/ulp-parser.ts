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
function extractDomain(url: string): string {
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
    // 2-field line: "login:password" — signal no-URL with empty string
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

  // Rule 1: blank / comment / section header / android / // prefix
  if (!trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('//') ||
      /^android:\/\//i.test(trimmed)) {
    return { credential: null, reason: 'blank' }
  }

  // Strip trailing pipe-separated noise (e.g. "url:login:pass|source|country")
  const clean = trimmed.includes('|') && !trimmed.startsWith('|')
    ? trimmed.split('|')[0].trim()
    : trimmed

  // Rule 2: separator detection (\t beats ; beats :)
  let url = '', login = '', password = ''
  if (clean.includes('\t')) {
    const parts = clean.split('\t')
    if (parts.length >= 3) {
      url      = parts[0].trim()
      login    = parts[1].trim()
      password = parts.slice(2).join('\t').trim()
    } else if (parts.length === 2) {
      login    = parts[0].trim()
      password = parts[1].trim()
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
  } else {
    const split = colonSplit(clean)
    if (!split) return { credential: null, reason: 'no_fields' }
    ;[url, login, password] = split
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
  let skipped       = 0

  for (const line of lines) {
    const { credential, reason } = parseLine(line, sourceFile)
    if (credential) {
      credentials.push(credential)
    } else {
      skipped++
      if (reason && reason in breakdown) breakdown[reason]++
    }
  }

  return { credentials, skipped, errors: 0, rejection_breakdown: breakdown }
}

export async function* parseULPStream(
  stream: ReadableStream<Uint8Array>,
  filename: string,
  batchSize: number,
): AsyncGenerator<ULPCredential[]> {
  const reader  = stream.getReader()
  const decoder = new TextDecoder()
  let   buffer  = ''
  let   batch:  ULPCredential[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const { credential } = parseLine(line, filename)
        if (credential) {
          batch.push(credential)
          if (batch.length >= batchSize) {
            yield batch
            batch = []
          }
        }
      }
    }
    // Flush remaining buffer
    if (buffer) {
      const { credential } = parseLine(buffer, filename)
      if (credential) batch.push(credential)
    }
    if (batch.length > 0) yield batch
  } finally {
    reader.releaseLock()
  }
}
