import { describe, test, expect, vi } from 'vitest'
import { restoreDeferredProjections } from '@/lib/content-dedup'

describe('restoreDeferredProjections', () => {
  test('runs every restorer in order and reports true when all succeed', async () => {
    const order: string[] = []
    const ok = await restoreDeferredProjections('cron', [
      { name: 'proj_email_domain_rev', run: async () => { order.push('email') } },
      { name: 'proj_imported_desc', run: async () => { order.push('imported') } },
    ])
    expect(ok).toBe(true)
    expect(order).toEqual(['email', 'imported'])
  })

  test('one failing restorer is reported with its name and re-run command but never blocks the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn().mockResolvedValue(undefined)
    const ok = await restoreDeferredProjections('cron', [
      { name: 'proj_email_domain_rev', run: async () => { throw new Error('disk headroom') } },
      { name: 'proj_imported_desc', run: second },
    ])
    expect(ok).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    const message = String(error.mock.calls[0][0])
    expect(message).toContain('proj_email_domain_rev')
    expect(message).toContain('--restore-projections')
    expect(String(error.mock.calls[0][1])).toContain('disk headroom')
    error.mockRestore()
  })

  test('reports false when the last one fails too, and when every one fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await restoreDeferredProjections('manual', [
      { name: 'a', run: async () => { throw new Error('x') } },
      { name: 'b', run: async () => { throw new Error('y') } },
    ])
    expect(ok).toBe(false)
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })
})
