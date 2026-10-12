import { describe, expect, it } from 'vitest'
import { ddlVersionToRecord } from '@/lib/clickhouse-migrations'

describe('ddlVersionToRecord', () => {
  it('records v28 when the ulp.sources identity columns were added', () => {
    expect(ddlVersionToRecord(false)).toBe(28)
  })

  it('keeps the version below v28 when that ALTER failed, so the next start tries it again', () => {
    expect(ddlVersionToRecord(true)).toBe(27)
  })
})
