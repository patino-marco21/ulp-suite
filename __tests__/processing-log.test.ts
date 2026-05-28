import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/sqlite', () => ({
  dbRun: vi.fn(),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet: vi.fn().mockReturnValue(undefined),
}))

import { dbRun } from '@/lib/sqlite'
import { logJob } from '@/lib/processing-log'

describe('logJob', () => {
  beforeEach(() => vi.clearAllMocks())

  test('inserts a done row with correct fields', () => {
    logJob({
      source:      'http',
      filename:    'test.txt',
      status:      'done',
      imported:    1000,
      skipped:     50,
      duration_ms: 3000,
      breach_name: 'SomeBreach',
    })

    expect(dbRun).toHaveBeenCalledOnce()
    const [sql, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(sql).toContain('INSERT INTO processing_jobs')
    expect(params).toContain('http')
    expect(params).toContain('test.txt')
    expect(params).toContain('done')
    expect(params).toContain(1000)
    expect(params).toContain(50)
    expect(params).toContain(3000)
    expect(params).toContain('SomeBreach')
  })

  test('includes error_message for a failed row', () => {
    logJob({
      source:        'inbox',
      filename:      'bad.zip',
      status:        'failed',
      imported:      0,
      skipped:       0,
      duration_ms:   500,
      error_message: 'unexpected EOF',
    })

    const [, params] = (dbRun as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(params).toContain('failed')
    expect(params).toContain('unexpected EOF')
  })

  test('is silent when dbRun throws', () => {
    ;(dbRun as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('db locked') })
    expect(() => logJob({
      source: 'http', filename: 'x.txt', status: 'done',
      imported: 0, skipped: 0, duration_ms: 0,
    })).not.toThrow()
  })
})
