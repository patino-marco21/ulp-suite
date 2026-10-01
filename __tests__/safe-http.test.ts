import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { UnsafeUrlError, allowPrivateHosts, isPublicAddress, postJsonSafely, resolveSafeTarget, webhookUrlProblem } from '@/lib/safe-http'

describe('isPublicAddress', () => {
  test.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '11.0.0.1', '169.253.0.1', '192.169.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888',
  ])('%s is public', ip => expect(isPublicAddress(ip)).toBe(true))

  test.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '172.18.0.2', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808',
    'not an address', '',
  ])('%s is not', ip => expect(isPublicAddress(ip)).toBe(false))
})

describe('allowPrivateHosts', () => {
  test.each([['1', true], ['true', true], [' YES ', true], ['on', true], ['', false], ['0', false], ['no', false], [undefined, false]])(
    'WEBHOOK_ALLOW_PRIVATE_HOSTS=%j -> %j',
    (raw, want) => {
      expect(allowPrivateHosts(raw === undefined ? ({} as NodeJS.ProcessEnv) : ({ WEBHOOK_ALLOW_PRIVATE_HOSTS: raw } as NodeJS.ProcessEnv))).toBe(want)
    },
  )
})

const resolveTo = (...addresses: string[]) => async () => addresses

describe('resolveSafeTarget — a webhook may only reach a public http(s) address', () => {
  const reject = (url: string, resolve = resolveTo('93.184.216.34')) => expect(resolveSafeTarget(url, { resolve })).rejects.toBeInstanceOf(UnsafeUrlError)

  test('a public hostname is accepted and its validated addresses are returned', async () => {
    const t = await resolveSafeTarget('https://hooks.example.com/x?y=1', { resolve: resolveTo('93.184.216.34') })
    expect(t.url.hostname).toBe('hooks.example.com')
    expect(t.addresses).toEqual(['93.184.216.34'])
  })

  test('only http and https', async () => {
    await reject('ftp://example.com/')
    await reject('file:///etc/passwd')
    await reject('gopher://example.com/')
    await reject('not a url')
  })

  test('no credentials in the URL', async () => {
    await reject('http://user:pw@example.com/')
  })

  test.each([
    'http://127.0.0.1:8123/?query=DROP%20TABLE%20ulp.credentials',
    'http://127.1/',
    'http://0.0.0.0/',
    'http://[::1]/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.0.10:8080/hook',
    'http://172.18.0.2:8123/',
    'http://[fd00::1]/',
    'http://2130706433/', // 127.0.0.1 as one decimal number
  ])('%s is refused', async url => {
    await reject(url)
  })

  test('localhost and its relatives are refused by name, before any DNS lookup', async () => {
    let looked = false
    const resolve = async () => {
      looked = true
      return ['93.184.216.34']
    }
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'printer.local', 'db.internal']) {
      await expect(resolveSafeTarget(`http://${host}/x`, { resolve })).rejects.toBeInstanceOf(UnsafeUrlError)
    }
    expect(looked).toBe(false)
  })

  test('a hostname that resolves to a private address (the Docker service names do) is refused', async () => {
    await reject('http://ulpsuite_clickhouse:8123/', resolveTo('172.18.0.2'))
    await reject('http://clickhouse:8123/', resolveTo('172.18.0.2'))
  })

  test('ONE private answer among public ones is enough to refuse it', async () => {
    await reject('http://rebind.example.com/', resolveTo('93.184.216.34', '10.0.0.1'))
  })

  test('a name that does not resolve is refused', async () => {
    await expect(resolveSafeTarget('http://nope.example.invalid/', { resolve: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) } })).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  test('with allowPrivate (a receiver on your own network) private addresses pass, other rules still apply', async () => {
    const t = await resolveSafeTarget('http://192.168.1.50:8080/hook', { allowPrivate: true })
    expect(t.addresses).toEqual(['192.168.1.50'])
    await expect(resolveSafeTarget('ftp://192.168.1.50/', { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(resolveSafeTarget('http://user:pw@192.168.1.50/', { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})

describe('webhookUrlProblem — the early check when a webhook is saved', () => {
  test('null for a public URL', async () => {
    expect(await webhookUrlProblem('https://hooks.example.com/x', { resolve: resolveTo('93.184.216.34') })).toBeNull()
  })

  test('says why a private target is refused, and how to allow your own network', async () => {
    const p = await webhookUrlProblem('http://192.168.1.50:8080/hook', { allowPrivate: false })
    expect(p).toMatch(/not allowed/)
    expect(p).toContain('WEBHOOK_ALLOW_PRIVATE_HOSTS=1')
  })

  test('a name that does not resolve YET is accepted: the receiver or its DNS may come up later, and every delivery checks again', async () => {
    const resolve = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }
    expect(await webhookUrlProblem('https://hooks.not-yet.example/x', { resolve })).toBeNull()
  })

  test('a name that resolves to a private address is refused even though it resolves', async () => {
    expect(await webhookUrlProblem('http://clickhouse:8123/', { resolve: resolveTo('172.18.0.2') })).toMatch(/not allowed/)
  })
})

describe('postJsonSafely', () => {
  let server: http.Server | null = null
  afterEach(() => {
    server?.closeAllConnections()
    server?.close()
    server = null
  })

  function listen(handler: http.RequestListener): Promise<number> {
    return new Promise(resolve => {
      server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port))
    })
  }

  test('refuses a private target by default and never contacts it', async () => {
    let hits = 0
    const port = await listen((_req, res) => { hits++; res.end('x') })
    await expect(postJsonSafely(`http://127.0.0.1:${port}/hook`, { headers: {}, body: '{}', timeoutMs: 2000 })).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(hits).toBe(0)
  })

  test('with allowPrivate it POSTs the body with the headers and reports the status', async () => {
    const seen: Array<{ method?: string; url?: string; body: string; type?: string; custom?: string }> = []
    const port = await listen((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'], custom: req.headers['x-custom'] as string })
        res.statusCode = 202
        res.end('ok')
      })
    })
    const r = await postJsonSafely(`http://127.0.0.1:${port}/hook?a=1`, {
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'yes' }, body: '{"k":"v"}', timeoutMs: 2000, allowPrivate: true,
    })
    expect(r.status).toBe(202)
    expect(seen).toEqual([{ method: 'POST', url: '/hook?a=1', body: '{"k":"v"}', type: 'application/json', custom: 'yes' }])
  })

  test('a redirect is reported, never followed (a receiver cannot bounce the request to an internal address)', async () => {
    let hits = 0
    const port = await listen((_req, res) => {
      hits++
      res.statusCode = 302
      res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/')
      res.end()
    })
    const r = await postJsonSafely(`http://127.0.0.1:${port}/`, { headers: {}, body: '{}', timeoutMs: 2000, allowPrivate: true })
    expect(r.status).toBe(302)
    expect(hits).toBe(1)
  })

  test('the connection goes to the address that was validated, whatever DNS says later (rebinding)', async () => {
    const port = await listen((_req, res) => { res.statusCode = 204; res.end() })
    // "rebind.test" does not resolve anywhere: the only way this connects is through the pinned, validated address.
    const r = await postJsonSafely(`http://rebind.test:${port}/`, { headers: {}, body: '{}', timeoutMs: 2000, allowPrivate: true, resolve: resolveTo('127.0.0.1') })
    expect(r.status).toBe(204)
  })

  test('a receiver that never answers is abandoned after the timeout', async () => {
    const port = await listen(() => { /* never respond */ })
    await expect(postJsonSafely(`http://127.0.0.1:${port}/`, { headers: {}, body: '{}', timeoutMs: 150, allowPrivate: true })).rejects.toThrow(/timeout/i)
  })
})
