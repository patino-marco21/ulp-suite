import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// No database: testWebhook reads its row through getWebhook -> dbGet.
let webhookRow: Record<string, unknown> | undefined
vi.mock('@/lib/sqlite', () => ({
  dbRun: vi.fn(),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet: vi.fn(() => webhookRow),
}))

import { attemptDelivery } from '@/lib/webhook-outbox-worker'
import { testWebhook } from '@/lib/domain-monitor'

let server: http.Server | null = null
let hits: Array<{ headers: http.IncomingHttpHeaders; body: string; url?: string }> = []

function listen(status = 200): Promise<number> {
  return new Promise(resolve => {
    server = http
      .createServer((req, res) => {
        let body = ''
        req.on('data', c => (body += c))
        req.on('end', () => {
          hits.push({ headers: req.headers, body, url: req.url })
          res.statusCode = status
          res.end('ok')
        })
      })
      .listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port))
  })
}

const saved = process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS
beforeEach(() => {
  hits = []
  webhookRow = undefined
  delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS
})
afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = null
  if (saved === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS
  else process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = saved
})

describe('attemptDelivery — webhooks cannot reach this machine or its network', () => {
  test('a loopback receiver is refused and never contacted; the failure says why', async () => {
    const port = await listen()
    const r = await attemptDelivery({ url: `http://127.0.0.1:${port}/hook`, secret: null, headers: null }, '{"x":1}')
    expect(r).toMatchObject({ ok: false, status: null })
    expect(r.error).toMatch(/not a public address/)
    expect(hits).toHaveLength(0)
  })

  test('the ClickHouse HTTP interface on the Docker network cannot be driven through a webhook URL', async () => {
    const r = await attemptDelivery({ url: 'http://172.18.0.2:8123/?query=DROP%20TABLE%20ulp.credentials%20SYNC', secret: null, headers: null }, '{}')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not a public address/)
  })

  test('the cloud metadata address and localhost by name are refused too', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/api/x']) {
      const r = await attemptDelivery({ url, secret: null, headers: null }, '{}')
      expect(r.ok, url).toBe(false)
      expect(r.status, url).toBeNull()
    }
  })

  test('with WEBHOOK_ALLOW_PRIVATE_HOSTS a receiver on your own network works, signed, with the headers', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = '1'
    const port = await listen(200)
    const body = '{"monitor_name":"m","matches":[]}'
    const r = await attemptDelivery({ url: `http://127.0.0.1:${port}/hook`, secret: 's3cret', headers: { 'X-Extra': 'yes' } }, body)
    expect(r).toEqual({ ok: true, status: 200, error: null })
    expect(hits).toHaveLength(1)
    expect(hits[0].body).toBe(body)
    expect(hits[0].headers['content-type']).toBe('application/json')
    expect(hits[0].headers['user-agent']).toBe('ULPSuite-DomainMonitor/1.0')
    expect(hits[0].headers['x-extra']).toBe('yes')
    expect(hits[0].headers['x-webhook-signature']).toBe(`sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`)
  })

  test('a non-2xx answer is a failure with the status, and a redirect is not followed', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = '1'
    const port = await listen(503)
    expect(await attemptDelivery({ url: `http://127.0.0.1:${port}/`, secret: null, headers: null }, '{}')).toEqual({ ok: false, status: 503, error: 'HTTP 503' })
    server?.close()
    const port2 = await listen(302)
    const r = await attemptDelivery({ url: `http://127.0.0.1:${port2}/`, secret: null, headers: null }, '{}')
    expect(r).toEqual({ ok: false, status: 302, error: 'HTTP 302' })
    expect(hits.filter(h => h.url === '/')).toHaveLength(2) // one request each, no follow-up
  })
})

describe('testWebhook (the "Test" button) goes through the same guard', () => {
  const row = (url: string) => ({ id: 1, name: 't', url, secret: null, headers: null, is_active: 1, created_by: 1 })

  test('refuses a private target without contacting it', async () => {
    const port = await listen()
    webhookRow = row(`http://127.0.0.1:${port}/hook`)
    const r = await testWebhook(1)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not a public address/)
    expect(hits).toHaveLength(0)
  })

  test('delivers the sample payload when private hosts are allowed', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = '1'
    const port = await listen(200)
    webhookRow = row(`http://127.0.0.1:${port}/hook`)
    const r = await testWebhook(1)
    expect(r).toMatchObject({ success: true, statusCode: 200 })
    expect(hits[0].headers['x-webhook-test']).toBe('true')
    expect(JSON.parse(hits[0].body).monitor_name).toBe('[TEST] Sample Monitor')
  })
})
