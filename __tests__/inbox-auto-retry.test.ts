import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClickHouseRetryExhaustedError } from '@/lib/clickhouse-retry'
import { ImportStalledError } from '@/lib/import-runner'
import { IngestHeldError, type GateReport } from '@/lib/ingest-quality-gate'
import { AUTO_RETRY_DELAY_MS, AUTO_RETRY_NOTE, isInterruption, mayAutoRetry, scheduleAutoRetry } from '@/lib/inbox-auto-retry'

describe('isInterruption', () => {
  it('is true for what happens to a run: a stall, an abort, a ClickHouse that dropped or timed out', () => {
    expect(isInterruption(new ImportStalledError('f.txt', 1_300_000))).toBe(true)
    expect(isInterruption(new DOMException('The operation was aborted', 'AbortError'))).toBe(true)
    expect(isInterruption(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isInterruption(new ClickHouseRetryExhaustedError(7, new Error('Timeout error.')))).toBe(true)
  })

  it('is false for what is wrong with the file or the request: a hold, a parse error, a SQL error, nothing', () => {
    expect(isInterruption(new IngestHeldError({ reasons: ['x'] } as unknown as GateReport))).toBe(false)
    expect(isInterruption(new Error('Unexpected token in the archive reference'))).toBe(false)
    expect(isInterruption(Object.assign(new Error('Syntax error: failed at position 5'), { code: '62' }))).toBe(false)
    expect(isInterruption(undefined)).toBe(false)
    expect(isInterruption('boom')).toBe(false)
  })
})

describe('mayAutoRetry', () => {
  it('allows a first retry: no earlier row, an earlier failure that scheduled none, a finished import', () => {
    expect(mayAutoRetry(undefined)).toBe(true)
    expect(mayAutoRetry({ status: 'failed', note: null })).toBe(true)
    expect(mayAutoRetry({ status: 'done', note: null })).toBe(true)
  })

  it('refuses a second one: the latest row for the name is the failure that scheduled the first', () => {
    expect(AUTO_RETRY_NOTE).toBe('auto-retry')
    expect(mayAutoRetry({ status: 'failed', note: AUTO_RETRY_NOTE })).toBe(false)
  })
})

describe('scheduleAutoRetry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('puts the file back after the delay, once, and not before', () => {
    const requeue = vi.fn().mockReturnValue(['a.txt'])
    scheduleAutoRetry('a.txt', { requeue })
    expect(AUTO_RETRY_DELAY_MS).toBe(120_000)
    vi.advanceTimersByTime(AUTO_RETRY_DELAY_MS - 1)
    expect(requeue).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(requeue).toHaveBeenCalledTimes(1)
    expect(requeue).toHaveBeenCalledWith(['a.txt'])
    vi.advanceTimersByTime(10 * AUTO_RETRY_DELAY_MS)
    expect(requeue).toHaveBeenCalledTimes(1)
  })

  it('does not keep the process alive, and does not throw when the file is gone', () => {
    const requeue = vi.fn().mockImplementation(() => { throw new Error('ENOENT') })
    expect(() => { scheduleAutoRetry('gone.txt', { requeue }); vi.advanceTimersByTime(AUTO_RETRY_DELAY_MS) }).not.toThrow()
  })
})
