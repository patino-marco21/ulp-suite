import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRow = vi.hoisted(() => ({ current: undefined as { value: string } | undefined }))

vi.mock('@/lib/sqlite', () => ({
  dbRun: vi.fn(),
  dbQuery: vi.fn().mockReturnValue([]),
  dbGet: vi.fn(() => mockRow.current),
}))

import { settingsManager } from '@/lib/settings'

describe('settingsManager.getMaxUploadFileSizeBytes (clamped, in bytes)', () => {
  beforeEach(() => {
    mockRow.current = undefined
    settingsManager.clearCache()
  })

  it('defaults to 10 GB in bytes when no row exists (not 10240 — that was the old MB-flavored bug)', async () => {
    const bytes = await settingsManager.getMaxUploadFileSizeBytes()
    expect(bytes).toBe(10 * 1024 ** 3)
  })

  it('returns the stored byte value as-is when within range', async () => {
    mockRow.current = { value: String(3 * 1024 ** 3) } // 3 GB
    const bytes = await settingsManager.getMaxUploadFileSizeBytes()
    expect(bytes).toBe(3 * 1024 ** 3)
  })

  it('clamps a value above the 100 GB ceiling (matches the settings page form bound)', async () => {
    mockRow.current = { value: String(500 * 1024 ** 3) }
    const bytes = await settingsManager.getMaxUploadFileSizeBytes()
    expect(bytes).toBe(100 * 1024 ** 3)
  })

  it('falls back to the default for a garbage/non-numeric stored value', async () => {
    mockRow.current = { value: 'not-a-number' }
    const bytes = await settingsManager.getMaxUploadFileSizeBytes()
    expect(bytes).toBe(10 * 1024 ** 3)
  })

  it('falls back to the default for a value below the sane floor (e.g. 0 or negative)', async () => {
    mockRow.current = { value: '0' }
    expect(await settingsManager.getMaxUploadFileSizeBytes()).toBe(10 * 1024 ** 3)

    settingsManager.clearCache()
    mockRow.current = { value: '-5' }
    expect(await settingsManager.getMaxUploadFileSizeBytes()).toBe(10 * 1024 ** 3)
  })

  it('getUploadSettings().max_file_size stays consistent with the dedicated getter (bytes, clamped)', async () => {
    mockRow.current = { value: String(500 * 1024 ** 3) }
    const settings = await settingsManager.getUploadSettings()
    expect(settings.max_file_size).toBe(100 * 1024 ** 3)
  })
})
