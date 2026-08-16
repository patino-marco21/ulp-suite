import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn().mockResolvedValue({ role: 'admin' }),
}))
vi.mock('@/lib/settings', () => ({
  settingsManager: {
    getUploadSettings: vi.fn().mockResolvedValue({
      max_file_size: 5 * 1024 ** 3,
      api_concurrency: 3,
      temp_cleanup_hours: 12,
    }),
  },
}))

import { GET } from '@/app/api/settings/upload/route'

describe('GET /api/settings/upload — response shape', () => {
  it('returns camelCase keys matching what app/settings/page.tsx reads (data.maxFileSize etc.), not the snake_case getUploadSettings() shape', async () => {
    const req = new NextRequest('http://localhost/api/settings/upload')
    const res = await GET(req)
    const json = await res.json()

    expect(json).toEqual({
      success: true,
      maxFileSize: 5 * 1024 ** 3,
      apiConcurrency: 3,
      tempCleanupHours: 12,
    })
    // The bug this guards: these snake_case keys used to be spread directly
    // into the response, which app/settings/page.tsx's camelCase reads
    // (data.maxFileSize) could never see — always NaN in the form.
    expect(json).not.toHaveProperty('max_file_size')
    expect(json).not.toHaveProperty('api_concurrency')
    expect(json).not.toHaveProperty('temp_cleanup_hours')
  })
})
