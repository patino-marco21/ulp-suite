import { describe, expect, it } from 'vitest'
import { ddlVersionToRecord } from '@/lib/clickhouse-migrations'

describe('ddlVersionToRecord', () => {
  it('records v29 when the ulp.sources identity columns and the address index were added', () => {
    expect(ddlVersionToRecord(false)).toBe(29)
    expect(ddlVersionToRecord(false, false)).toBe(29)
  })

  it('keeps the version below v29 when the ADD INDEX failed, so the next start tries it again', () => {
    expect(ddlVersionToRecord(false, true)).toBe(28)
  })

  it('keeps the version below v28 when that ALTER failed, whatever happened to v29', () => {
    expect(ddlVersionToRecord(true)).toBe(27)
    expect(ddlVersionToRecord(true, false)).toBe(27)
    expect(ddlVersionToRecord(true, true)).toBe(27)
  })
})
