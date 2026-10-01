import { isIP } from 'node:net'

/**
 * Who is calling, as far as the request headers can prove.
 *
 * Next.js only fills in X-Forwarded-For when the caller did not send one (`req.headers['x-forwarded-for']
 * ??= socket.remoteAddress`, node_modules/next/dist/server/base-server.js). With nothing in front of the
 * app, a client that sends the header picks its own address: it can rotate values to dodge a per-IP limit
 * and write whatever it likes into the audit log. With a reverse proxy in front the proxy APPENDS the
 * address it saw, so the right-most entries are the ones the client could not choose.
 *
 * TRUST_PROXY_HOPS is how many such proxies sit in front of the app (default 0: none). The client is then
 * the entry `hops` positions from the right.
 */

type HeaderReader = { get(name: string): string | null }

const MAX_HOPS = 10
// 10 hops of IPv6 with ports is under 600 characters; anything longer is not a proxy chain.
const MAX_HEADER_LENGTH = 2048

export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.TRUST_PROXY_HOPS ?? '').trim()
  if (!/^\d+$/.test(raw)) return 0
  const n = Number(raw)
  return n >= 1 && n <= MAX_HOPS ? n : 0
}

function forwardedEntries(headers: HeaderReader): string[] {
  const raw = headers.get('x-forwarded-for') ?? ''
  if (raw.length > MAX_HEADER_LENGTH) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/** One X-Forwarded-For entry as an IP literal (a trailing :port or [v6]:port is dropped), or null. */
function parseEntry(entry: string): string | null {
  let s = entry.trim()
  if (s.length === 0 || s.length > 64) return null
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(s)
  if (bracketed) {
    s = bracketed[1]
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(s)
    if (withPort) s = withPort[1]
  }
  return isIP(s) ? s : null
}

/**
 * The caller's address when a trusted proxy vouches for it, else null. X-Real-IP is deliberately ignored: a
 * proxy only overwrites it if it was configured to, and otherwise it passes the client's value through.
 */
export function trustedClientIp(headers: HeaderReader, env: NodeJS.ProcessEnv = process.env): string | null {
  const hops = trustedProxyHops(env)
  if (hops === 0) return null
  const entries = forwardedEntries(headers)
  if (entries.length < hops) return null // the proxy is not appending: do not guess
  return parseEntry(entries[entries.length - hops])
}

/**
 * Address to record in the audit and API-request logs, or null. Behind a trusted proxy it is the trusted
 * address. With none it is the first entry, which is the real peer unless the caller sent the header
 * itself, so treat it as a lead and not as proof. Only an IP literal is ever returned, so nothing a client
 * writes into the header can reach the database as text.
 */
export function clientIpForLog(headers: HeaderReader, env: NodeJS.ProcessEnv = process.env): string | null {
  if (trustedProxyHops(env) > 0) return trustedClientIp(headers, env)
  const entries = forwardedEntries(headers)
  return entries.length > 0 ? parseEntry(entries[0]) : null
}

/**
 * What a rate limiter should key on: the trusted address, or one shared key when the app cannot tell
 * callers apart. Rotating X-Forwarded-For then buys nothing, because every caller lands in the same bucket.
 */
export function rateLimitKey(headers: HeaderReader, env: NodeJS.ProcessEnv = process.env): string {
  return trustedClientIp(headers, env) ?? 'direct'
}
