import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '1', role: 'admin' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/domain-monitor', () => ({
  createWebhook: vi.fn().mockResolvedValue(7),
  updateWebhook: vi.fn().mockResolvedValue(undefined),
  getWebhook: vi.fn(),
  listWebhooks: vi.fn().mockResolvedValue([]),
  deleteWebhook: vi.fn(),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/monitoring/webhooks/route'
import { PUT } from '@/app/api/monitoring/webhooks/[id]/route'
import { createWebhook, getWebhook, updateWebhook } from '@/lib/domain-monitor'

const mockCreate = vi.mocked(createWebhook)
const mockUpdate = vi.mocked(updateWebhook)

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/monitoring/webhooks', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const put = (body: unknown) =>
  PUT(new NextRequest('http://localhost/api/monitoring/webhooks/3', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), {
    params: Promise.resolve({ id: '3' }),
  })

const saved = process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getWebhook).mockResolvedValue({ id: 3, name: 'w', url: 'https://93.184.216.34/old', secret: null, headers: null, is_active: 1 } as never)
  mockCreate.mockResolvedValue(7)
  delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS
  if (saved !== undefined) process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = saved
})

const UNSAFE = [
  'http://127.0.0.1:8123/?query=DROP%20TABLE%20ulp.credentials',
  'http://localhost:8123/',
  'http://169.254.169.254/latest/meta-data/',
  'http://[::1]:3000/',
  'http://10.0.0.5/hook',
  'ftp://93.184.216.34/x',
  'http://user:pw@93.184.216.34/x',
]

describe('creating a webhook', () => {
  test.each(UNSAFE)('%s is refused with a 400 that says why, and nothing is stored', async url => {
    const res = await post({ name: 'w', url })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/webhook url/i)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('a public https URL is stored', async () => {
    const res = await post({ name: 'w', url: 'https://93.184.216.34/hook' })
    expect(res.status).toBe(200)
    expect(mockCreate).toHaveBeenCalledOnce()
  })

  test('with WEBHOOK_ALLOW_PRIVATE_HOSTS a receiver on your own network is accepted; the scheme and credential rules stay', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = '1'
    expect((await post({ name: 'w', url: 'http://192.168.1.50:8080/hook' })).status).toBe(200)
    expect((await post({ name: 'w', url: 'ftp://192.168.1.50/x' })).status).toBe(400)
    expect((await post({ name: 'w', url: 'http://u:p@192.168.1.50/x' })).status).toBe(400)
  })

  test('the refusal tells the operator how to allow a receiver on their own network', async () => {
    const json = await (await post({ name: 'w', url: 'http://192.168.1.50:8080/hook' })).json()
    expect(json.error).toContain('WEBHOOK_ALLOW_PRIVATE_HOSTS')
  })
})

describe('updating a webhook URL', () => {
  test.each(UNSAFE)('%s is refused and the stored URL is not changed', async url => {
    const res = await put({ url })
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  test('a public URL is accepted', async () => {
    const res = await put({ url: 'https://93.184.216.34/new' })
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledOnce()
  })

  test('an update that does not touch the URL is not blocked by the URL rule', async () => {
    const res = await put({ name: 'renamed' })
    expect(res.status).toBe(200)
  })
})
