import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn(),
    statSync:    vi.fn(),
    renameSync:  vi.fn(),
  },
}))

import fs from 'fs'
import { getWaiting, getFailed, getDoneCount, retryFiles, retryAllFailed } from '@/lib/inbox-helpers'

const mockDirent = (name: string, isFile = true) => ({
  name,
  isFile: () => isFile,
  isDirectory: () => !isFile,
})

const mockStat = (size: number, mtime: Date) => ({
  size,
  mtime,
  isFile: () => true,
})

describe('getWaiting', () => {
  beforeEach(() => vi.clearAllMocks())

  test('returns files sorted oldest-first, excludes done/ and failed/ dirs', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('batch_002.txt'),
      mockDirent('done', false),
      mockDirent('failed', false),
      mockDirent('batch_001.txt'),
    ] as any)
    vi.mocked(fs.statSync).mockImplementation((p: any) => {
      const old = String(p).includes('001')
      return mockStat(old ? 100 : 200, new Date(old ? '2026-01-01' : '2026-01-02')) as any
    })

    const result = getWaiting()
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('batch_001.txt')
    expect(result[1].name).toBe('batch_002.txt')
  })

  test('returns empty array when directory does not exist', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(getWaiting()).toEqual([])
  })
})

describe('getDoneCount', () => {
  beforeEach(() => vi.clearAllMocks())

  test('returns count of files in done/', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('file1.txt'),
      mockDirent('file2.txt'),
    ] as any)
    expect(getDoneCount()).toBe(2)
  })

  test('returns 0 when done/ does not exist', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(getDoneCount()).toBe(0)
  })
})

describe('retryFiles', () => {
  beforeEach(() => vi.clearAllMocks())

  test('moves listed files from failed/ to inbox/', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    const moved = retryFiles(['a.txt', 'b.txt'])
    expect(moved).toEqual(['a.txt', 'b.txt'])
    expect(fs.renameSync).toHaveBeenCalledTimes(2)
  })

  test('rejects filenames containing path traversal', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    const moved = retryFiles(['../../../etc/passwd', '..\\secret', 'safe.txt'])
    expect(moved).toEqual(['safe.txt'])
  })

  test('skips files that do not exist (renameSync throws)', () => {
    vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error('ENOENT') })
    const moved = retryFiles(['missing.txt'])
    expect(moved).toEqual([])
  })
})

describe('retryAllFailed', () => {
  beforeEach(() => vi.clearAllMocks())

  test('retries all files in failed/', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('a.txt'),
      mockDirent('b.zip'),
    ] as any)
    vi.mocked(fs.renameSync).mockImplementation(() => {})
    const moved = retryAllFailed()
    expect(moved).toHaveLength(2)
  })
})
