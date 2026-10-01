import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

/**
 * Outbound HTTP for webhooks that cannot be turned on the machine that sends it.
 *
 * A webhook URL is typed in by whoever administers the app, and the app then POSTs match data to it from inside the
 * Docker network, where ClickHouse's HTTP interface answers a bare `?query=` request without a password. With only
 * `url.startsWith("http")` as validation a webhook could target http://ulpsuite_clickhouse:8123/?query=DROP%20TABLE...
 * (or localhost, or the cloud metadata address) and the server would send it. So:
 *
 *  - only http(s), no credentials in the URL, no localhost / *.local / *.internal;
 *  - every address the name resolves to must be public (private, loopback, link-local, CGNAT, documentation,
 *    multicast and reserved ranges are refused; ONE bad answer refuses the lot);
 *  - the connection is pinned to the addresses that were validated, so a second DNS answer cannot redirect it;
 *  - redirects are reported, never followed.
 *
 * WEBHOOK_ALLOW_PRIVATE_HOSTS=1 lifts the address rule for a receiver on your own network (the other rules stay).
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

const blocked = new BlockList()
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const V6: Array<[string, number]> = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6')

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return false
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is never a destination a webhook needs. It is not listed in the BlockList:
  // Node checks IPv4 addresses against IPv6 rules in their mapped form, so a ::ffff:0:0/96 rule would match every IPv4.
  if (family === 6 && /^::ffff:/i.test(ip)) return false
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

export function allowPrivateHosts(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env.WEBHOOK_ALLOW_PRIVATE_HOSTS ?? '').trim().toLowerCase())
}

export type Resolver = (hostname: string) => Promise<string[]>

const systemResolver: Resolver = async hostname => (await dnsLookup(hostname, { all: true })).map(a => a.address)

interface TargetOptions {
  allowPrivate?: boolean
  resolve?: Resolver
}

/** The URL and the addresses it was validated against. Throws UnsafeUrlError for anything that may not be contacted. */
export async function resolveSafeTarget(urlStr: string, opts: TargetOptions = {}): Promise<{ url: URL; addresses: string[] }> {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    throw new UnsafeUrlError('not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('only http and https URLs are allowed')
  if (url.username || url.password) throw new UnsafeUrlError('credentials in the URL are not allowed (use the secret or a header)')

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === '') throw new UnsafeUrlError('the URL has no host')

  const literal = isIP(host) !== 0
  if (!literal && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) {
    if (!opts.allowPrivate) throw new UnsafeUrlError(`${host} is not a public address`)
  }

  let addresses: string[]
  if (literal) {
    addresses = [host]
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolver)(host)
    } catch {
      throw new UnsafeUrlError(`${host} cannot be resolved`)
    }
    if (addresses.length === 0) throw new UnsafeUrlError(`${host} cannot be resolved`)
  }

  if (!opts.allowPrivate) {
    const bad = addresses.find(a => !isPublicAddress(a))
    if (bad !== undefined) throw new UnsafeUrlError(`${host} is not a public address (${literal ? 'it is a private or reserved address' : 'it resolves to a private or reserved address'})`)
  }
  return { url, addresses }
}

/** A `lookup` that answers with the already-validated addresses and never asks DNS again. */
function pinnedLookup(addresses: string[]): LookupFunction {
  // Node asks for every address when it races IPv4/IPv6 (`all`), for one otherwise; the typings only model one.
  const fn = (_hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void): void => {
    if (options?.all) cb(null, addresses.map(address => ({ address, family: isIP(address) })))
    else cb(null, addresses[0], isIP(addresses[0]))
  }
  return fn as unknown as LookupFunction
}

/**
 * POST a JSON body and report the HTTP status. Rejects with UnsafeUrlError for a target that may not be contacted, and
 * with a plain Error on a network failure or timeout. The response body is discarded.
 */
export async function postJsonSafely(
  urlStr: string,
  opts: TargetOptions & { headers: Record<string, string>; body: string; timeoutMs: number },
): Promise<{ status: number }> {
  const { url, addresses } = await resolveSafeTarget(urlStr, opts)
  const secure = url.protocol === 'https:'
  const host = url.hostname.replace(/^\[|\]$/g, '')

  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...opts.headers, 'Content-Length': String(Buffer.byteLength(opts.body)) },
        agent: false,
        timeout: opts.timeoutMs,
        servername: isIP(host) === 0 ? host : undefined,
        // Connect only to what was just validated, so a second DNS answer (rebinding) cannot send this elsewhere.
        lookup: pinnedLookup(addresses),
      },
      res => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)))
    req.on('error', reject)
    req.end(opts.body)
  })
}

/**
 * Why a webhook URL may not be saved, or null if it may. A name that does not resolve YET is accepted (the receiver or its
 * DNS may come up later); every delivery resolves and validates again, so this is the early, friendly check, not the guard.
 */
export async function webhookUrlProblem(urlStr: string, opts: TargetOptions = {}): Promise<string | null> {
  try {
    await resolveSafeTarget(urlStr, { allowPrivate: allowPrivateHosts(), ...opts })
    return null
  } catch (err) {
    if (!(err instanceof UnsafeUrlError)) return 'The webhook URL could not be checked'
    if (err.message.endsWith('cannot be resolved')) return null
    const hint = /not a public address/.test(err.message)
      ? ' To allow a receiver on your own network, set WEBHOOK_ALLOW_PRIVATE_HOSTS=1 in .env.'
      : ''
    return `The webhook URL is not allowed: ${err.message}.${hint}`
  }
}
