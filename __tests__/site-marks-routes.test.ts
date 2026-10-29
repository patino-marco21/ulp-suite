import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn() }))

import { NextRequest } from 'next/server'
import { validateRequest, type JWTPayload } from '@/lib/auth'
import { dbRun } from '@/lib/sqlite'
import { POST, PUT } from '@/app/api/lookup/marks/route'

const admin: JWTPayload = { userId: '1', username: 'Admin', email: 'admin@example.test', role: 'admin' }
const analyst: JWTPayload = { userId: '2', username: 'Ana', email: 'ana@example.test', role: 'analyst' }

const send = (handler: (request: NextRequest) => Promise<Response>, method: 'POST' | 'PUT', body: unknown) =>
  handler(new NextRequest('http://localhost/api/lookup/marks', { method, body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => {
  vi.mocked(validateRequest).mockResolvedValue(admin)
  dbRun('DELETE FROM site_marks')
})

describe.each([
  ['POST', POST, { hosts: ['corp.example'] }],
  ['PUT', PUT, { host: 'corp.example', status: 'done' }],
] as const)('%s /api/lookup/marks', (method, handler, validBody) => {
  test('needs a session: 401 without one, and nothing is read or written', async () => {
    vi.mocked(validateRequest).mockResolvedValue(null)
    const res = await send(handler, method, validBody)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    vi.mocked(validateRequest).mockResolvedValue(admin)
    const read = await send(POST, 'POST', { hosts: ['corp.example'] })
    expect((await read.json()).marks).toEqual({})
  })

  test('refuses a body that is not JSON (400)', async () => {
    const res = await send(handler, method, '{not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'Invalid JSON body' })
  })
})

describe('the two verbs together', () => {
  test('a mark set with PUT is read back by POST, with who set it', async () => {
    const put = await send(PUT, 'PUT', { host: 'corp.example', status: 'todo', note: 'look at the sign-up page' })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      success: true,
      host: 'corp.example',
      mark: { status: 'todo', note: 'look at the sign-up page', updated_by: 'admin@example.test', updated_at: expect.any(String) },
    })
    const read = await send(POST, 'POST', { hosts: ['corp.example', 'other.example'] })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({
      success: true,
      marks: { 'corp.example': { status: 'todo', note: 'look at the sign-up page', updated_by: 'admin@example.test', updated_at: expect.any(String) } },
    })
  })

  test('an analyst can mark a site too, and the mark then carries the analyst, not the admin', async () => {
    await send(PUT, 'PUT', { host: 'corp.example', status: 'done' })
    vi.mocked(validateRequest).mockResolvedValue(analyst)
    const res = await send(PUT, 'PUT', { host: 'corp.example', status: 'skip' })
    expect(res.status).toBe(200)
    expect((await res.json()).mark).toMatchObject({ status: 'skip', updated_by: 'ana@example.test' })
  })

  test('a session whose token carries no e-mail address is named by its sign-in name', async () => {
    vi.mocked(validateRequest).mockResolvedValue({ userId: '3', username: 'Old Token' })
    const res = await send(PUT, 'PUT', { host: 'corp.example', status: 'done' })
    expect((await res.json()).mark.updated_by).toBe('Old Token')
  })

  test('only the fields sent change, and clearing both removes the mark', async () => {
    await send(PUT, 'PUT', { host: 'corp.example', status: 'done', note: 'n' })
    const noteOnly = await send(PUT, 'PUT', { host: 'corp.example', note: 'changed' })
    expect((await noteOnly.json()).mark).toMatchObject({ status: 'done', note: 'changed' })
    const cleared = await send(PUT, 'PUT', { host: 'corp.example', status: null, note: null })
    expect(await cleared.json()).toEqual({ success: true, host: 'corp.example', mark: null })
    const read = await send(POST, 'POST', { hosts: ['corp.example'] })
    expect((await read.json()).marks).toEqual({})
  })

  test('the checks of the library are the route\'s: a host as typed, a status outside the list and an empty read are 400', async () => {
    expect((await send(PUT, 'PUT', { host: 'https://www.corp.example/login', status: 'done' })).status).toBe(400)
    expect((await send(PUT, 'PUT', { host: 'corp.example', status: 'finished' })).status).toBe(400)
    expect((await send(POST, 'POST', { hosts: [] })).status).toBe(400)
    const read = await send(POST, 'POST', { hosts: ['corp.example'] })
    expect((await read.json()).marks).toEqual({})
  })
})
