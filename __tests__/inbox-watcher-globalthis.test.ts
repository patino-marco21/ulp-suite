import { describe, test, expect, afterEach } from 'vitest'
import { getInFlightCount, getInboxJobProgress, getInboxJobsProgress } from '@/lib/inbox-watcher'

describe('inbox-watcher globalThis-backed state (survives cross-chunk duplication)', () => {
  afterEach(() => {
    globalThis.__ulpInFlight?.delete('probe-globalthis-inflight.txt')
    globalThis.__ulpJobProgress?.clear()
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

  test('the progress of the files being imported is read from a globalThis-backed map, the oldest first', () => {
    expect(getInboxJobProgress()).toBeNull()
    expect(getInboxJobsProgress()).toEqual([])
    expect(globalThis.__ulpJobProgress).toBeInstanceOf(Map)
    globalThis.__ulpJobProgress!.set('newer.txt', { filename: 'newer.txt', started_at: 2_000, rows_imported: 1, file_size_bytes: 10 })
    globalThis.__ulpJobProgress!.set('older.txt', { filename: 'older.txt', started_at: 1_000, rows_imported: 5, file_size_bytes: 100 })
    expect(getInboxJobsProgress().map(p => p.filename)).toEqual(['older.txt', 'newer.txt'])
    expect(getInboxJobProgress()).toEqual({ filename: 'older.txt', started_at: 1_000, rows_imported: 5, file_size_bytes: 100 })
  })
})
