import { describe, test, expect } from 'vitest'
import { trustedProxyHops, trustedClientIp, clientIpForLog, rateLimitKey } from '@/lib/client-ip'

const h = (xff?: string) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff })
const env = (hops?: string) => ({ ...(hops === undefined ? {} : { TRUST_PROXY_HOPS: hops }) }) as NodeJS.ProcessEnv

describe('trustedProxyHops — how many reverse proxies append to X-Forwarded-For (0 = none, the default)', () => {
  test.each([
    [undefined, 0], ['', 0], ['0', 0], ['1', 1], [' 2 ', 2], ['10', 10],
    ['-1', 0], ['abc', 0], ['1.5', 0], ['11', 0], ['999', 0],
  ])('TRUST_PROXY_HOPS=%j -> %j', (raw, want) => {
    expect(trustedProxyHops(env(raw as string | undefined))).toBe(want)
  })
})

describe('trustedClientIp — an address a client cannot choose, or null', () => {
  test('no trusted proxy: nothing in the headers can be believed, so there is no trusted address', () => {
    // Next.js only fills in X-Forwarded-For when the client sent none, so with nothing in front of the app
    // the header is whatever the caller wrote.
    expect(trustedClientIp(h('203.0.113.9'), env())).toBeNull()
    expect(trustedClientIp(h('1.2.3.4, 203.0.113.9'), env('0'))).toBeNull()
  })

  test('one proxy: the entry it appended (the right-most) is the client, whatever the client put in front of it', () => {
    expect(trustedClientIp(h('203.0.113.9'), env('1'))).toBe('203.0.113.9')
    expect(trustedClientIp(h('198.51.100.7, 203.0.113.9'), env('1'))).toBe('203.0.113.9')
    expect(trustedClientIp(h('1.1.1.1, 2.2.2.2, 203.0.113.9'), env('1'))).toBe('203.0.113.9')
  })

  test('two proxies: the entry the OUTER proxy appended', () => {
    // client 203.0.113.9 -> edge proxy (appends the client) -> inner proxy (appends the edge) -> app
    expect(trustedClientIp(h('203.0.113.9, 10.0.0.2'), env('2'))).toBe('203.0.113.9')
    expect(trustedClientIp(h('forged, 203.0.113.9, 10.0.0.2'), env('2'))).toBe('203.0.113.9')
  })

  test('a chain shorter than the configured hops means the proxy is not appending: no trusted address', () => {
    expect(trustedClientIp(h('203.0.113.9'), env('2'))).toBeNull()
    expect(trustedClientIp(h(), env('1'))).toBeNull()
    expect(trustedClientIp(h(''), env('1'))).toBeNull()
  })

  test('the address must be an IP literal: junk, hostnames and markup are refused', () => {
    expect(trustedClientIp(h('<script>alert(1)</script>'), env('1'))).toBeNull()
    expect(trustedClientIp(h('evil.example'), env('1'))).toBeNull()
    expect(trustedClientIp(h('unknown'), env('1'))).toBeNull()
    expect(trustedClientIp(h('1.2.3.4, ' + 'a'.repeat(5000)), env('1'))).toBeNull()
  })

  test('IPv6, IPv4-mapped IPv6 and a trailing :port are understood', () => {
    expect(trustedClientIp(h('2001:db8::1'), env('1'))).toBe('2001:db8::1')
    expect(trustedClientIp(h('::ffff:203.0.113.9'), env('1'))).toBe('::ffff:203.0.113.9')
    expect(trustedClientIp(h('203.0.113.9:51234'), env('1'))).toBe('203.0.113.9')
    expect(trustedClientIp(h('[2001:db8::1]:443'), env('1'))).toBe('2001:db8::1')
  })

  test('X-Real-IP is never believed (a proxy only overwrites it if it was configured to)', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.9' })
    expect(trustedClientIp(headers, env('1'))).toBeNull()
  })
})

describe('clientIpForLog — best effort for the audit and API logs', () => {
  test('behind a trusted proxy it is the trusted address', () => {
    expect(clientIpForLog(h('forged, 203.0.113.9'), env('1'))).toBe('203.0.113.9')
  })

  test('with no proxy it is the first valid entry, which is the real peer unless the caller sent the header', () => {
    expect(clientIpForLog(h('172.18.0.1'), env())).toBe('172.18.0.1')
    expect(clientIpForLog(h('203.0.113.9, 10.0.0.2'), env())).toBe('203.0.113.9')
  })

  test('it never stores text that is not an IP address', () => {
    expect(clientIpForLog(h('<script>'), env())).toBeNull()
    expect(clientIpForLog(h('x'.repeat(2000)), env())).toBeNull()
    expect(clientIpForLog(h(), env())).toBeNull()
  })

  test('a configured proxy that is not appending gives null, not a guess', () => {
    expect(clientIpForLog(h('203.0.113.9'), env('2'))).toBeNull()
  })
})

describe('rateLimitKey — what a limiter is keyed on', () => {
  test('the trusted address when there is one', () => {
    expect(rateLimitKey(h('forged, 203.0.113.9'), env('1'))).toBe('203.0.113.9')
  })

  test('one shared key when the app cannot tell clients apart, so rotating X-Forwarded-For buys nothing', () => {
    const keys = new Set(['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'].map(ip => rateLimitKey(h(ip), env())))
    expect(keys.size).toBe(1)
    expect([...keys][0]).toBe('direct')
  })
})
