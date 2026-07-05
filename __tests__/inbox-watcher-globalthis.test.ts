import { describe, test, expect, afterEach } from 'vitest'
import { getInFlightCount, getInboxJobProgress } from '@/lib/inbox-watcher'

describe('inbox-watcher globalThis-backed state (survives cross-chunk duplication)', () => {
  afterEach(() => {
    globalThis.__ulpInFlight?.delete('probe-globalthis-inflight.txt')
    globalThis.__ulpCurrentProgress = null
  })

  test('getInFlightCount reads from the globalThis-backed Set', () => {
    const before = getInFlightCount()
    expect(globalThis.__ulpInFlight).toBeInstanceOf(Set)
    globalThis.__ulpInFlight!.add('probe-globalthis-inflight.txt')
    expect(getInFlightCount()).toBe(before + 1)
    globalThis.__ulpInFlight!.delete('probe-globalthis-inflight.txt')
    expect(getInFlightCount()).toBe(before)
  })

  test('pendingTasks is also globalThis-backed', () => {
    expect(globalThis.__ulpPendingTasks).toBeInstanceOf(Set)
  })

  test('getInboxJobProgress reads from the globalThis-backed value', () => {
    expect(getInboxJobProgress()).toBeNull()
    globalThis.__ulpCurrentProgress = {
      filename: 'probe.txt', started_at: Date.now(), rows_imported: 5, file_size_bytes: 100,
    }
    expect(getInboxJobProgress()).toEqual({
      filename: 'probe.txt', started_at: expect.any(Number), rows_imported: 5, file_size_bytes: 100,
    })
  })
})
