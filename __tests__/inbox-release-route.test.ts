import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  getHeld: vi.fn(),
  releaseFiles: vi.fn(),
  addGateOverride: vi.fn(),
  removeGateOverride: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ userId: '4', role: 'admin', email: 'admin@example.com' }),
  requireAdminRole: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/inbox-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/inbox-helpers')>('@/lib/inbox-helpers')
  return { ...actual, getHeld: h.getHeld, releaseFiles: h.releaseFiles }
})
vi.mock('@/lib/ingest-gate-store', () => ({ addGateOverride: h.addGateOverride, removeGateOverride: h.removeGateOverride }))
vi.mock('@/lib/audit-log', () => ({ logUploadAction: h.audit }))

import { POST } from '@/app/api/inbox/release/route'

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/inbox/release', { method: 'POST', body: JSON.stringify(body) }))
const admin = { id: 4, email: 'admin@example.com' }

beforeEach(() => {
  h.order.length = 0
  for (const fn of [h.getHeld, h.releaseFiles, h.addGateOverride, h.removeGateOverride, h.audit]) fn.mockReset()
  h.addGateOverride.mockImplementation((name: string) => { h.order.push(`override:${name}`); return true })
  h.releaseFiles.mockImplementation((names: string[]) => { h.order.push(`move:${names.join(',')}`); return names })
  h.audit.mockResolvedValue(1)
})

describe('POST /api/inbox/release', () => {
  it('stores the one-shot release BEFORE it moves the file (the watcher could claim it the moment it is back), then records who released what', async () => {
    const res = await post({ filename: 'a.txt' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, moved: ['a.txt'] })
    expect(h.order).toEqual(['override:a.txt', 'move:a.txt'])
    expect(h.addGateOverride).toHaveBeenCalledWith('a.txt', 'admin@example.com')
    expect(h.audit).toHaveBeenCalledWith('inbox.release', admin, null, { moved: ['a.txt'], mode: 'one' }, expect.anything())
  })

  it('releases every held file for { all: true }', async () => {
    h.getHeld.mockReturnValue([{ name: 'a.txt' }, { name: 'b.zip' }])
    const res = await post({ all: true })
    expect((await res.json()).moved).toEqual(['a.txt', 'b.zip'])
    expect(h.audit).toHaveBeenCalledWith('inbox.release', admin, null, { moved: ['a.txt', 'b.zip'], mode: 'all' }, expect.anything())
  })

  it('withdraws the release when the file could not be moved', async () => {
    h.releaseFiles.mockReturnValue([])
    const res = await post({ filename: 'gone.txt' })
    expect((await res.json()).moved).toEqual([])
    expect(h.removeGateOverride).toHaveBeenCalledWith('gone.txt')
  })

  it('does not move a file whose release could not be stored: it would only be held again', async () => {
    h.addGateOverride.mockReturnValue(false)
    const res = await post({ filename: 'a.txt' })
    expect((await res.json()).moved).toEqual([])
    expect(h.releaseFiles).not.toHaveBeenCalled()
  })

  it('refuses a name that is a path, without storing anything', async () => {
    const res = await post({ filename: '../x.txt' })
    expect((await res.json()).moved).toEqual([])
    expect(h.addGateOverride).not.toHaveBeenCalled()
    expect(h.releaseFiles).not.toHaveBeenCalled()
  })

  it('rejects a malformed body and records nothing', async () => {
    const res = await post({ nothing: true })
    expect(res.status).toBe(400)
    expect(h.audit).not.toHaveBeenCalled()
    const notJson = await POST(new NextRequest('http://localhost/api/inbox/release', { method: 'POST', body: '{' }))
    expect(notJson.status).toBe(400)
  })
})
