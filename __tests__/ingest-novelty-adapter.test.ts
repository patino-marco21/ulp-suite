import type { ClickHouseClient } from '@clickhouse/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/clickhouse', () => ({ getClient: vi.fn() }))

import { getClient } from '@/lib/clickhouse'
import { clickhouseNoveltyDb } from '@/lib/ingest-novelty'

// The seam is what the adapter hands the ClickHouse client for a statement; the client itself is the boundary.
const command = vi.fn()

beforeEach(() => {
  command.mockReset().mockResolvedValue({ summary: { written_rows: '7' } })
  vi.mocked(getClient).mockReturnValue({ command } as unknown as ClickHouseClient)
})

const exec = (settings?: Record<string, number>) =>
  clickhouseNoveltyDb().exec('INSERT INTO ulp.credentials SELECT 1', { queryId: 'novelty-test', signal: new AbortController().signal, settings })

const sentSettings = (call: number) => command.mock.calls[call][0].clickhouse_settings

describe('clickhouseNoveltyDb().exec', () => {
  it('sends the commit settings with the statement\'s own on top, and reports the rows the server wrote', async () => {
    expect(await exec({ max_insert_threads: 4 })).toEqual({ writtenRows: 7 })
    expect(sentSettings(0)).toMatchObject({ max_execution_time: 3300, insert_deduplicate: 0, async_insert: 0, use_query_cache: 0, max_insert_threads: 4 })
  })

  it('sends no max_insert_threads for a statement that asks for none', async () => {
    await exec()
    expect(sentSettings(0)).not.toHaveProperty('max_insert_threads')
  })

  it('does not leak one statement\'s settings into the next', async () => {
    await exec({ max_insert_threads: 4 })
    await exec()
    expect(sentSettings(1)).not.toHaveProperty('max_insert_threads')
  })
})
