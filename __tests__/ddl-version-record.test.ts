import { describe, expect, it } from 'vitest'
import { ddlVersionToRecord } from '@/lib/clickhouse-migrations'

describe('ddlVersionToRecord', () => {
  it('records v31 when the ulp.sources identity columns, the address index, the norm_key_hash column and the parser revision column were added', () => {
    expect(ddlVersionToRecord(false)).toBe(31)
    expect(ddlVersionToRecord(false, false)).toBe(31)
    expect(ddlVersionToRecord(false, false, false)).toBe(31)
    expect(ddlVersionToRecord(false, false, false, false)).toBe(31)
  })

  it('keeps the version below v31 when the parser_revision ADD COLUMN failed, so the next start tries it again', () => {
    expect(ddlVersionToRecord(false, false, false, true)).toBe(30)
  })

  it('keeps the version below v30 when the norm_key_hash ADD COLUMN failed, whatever happened to v31', () => {
    expect(ddlVersionToRecord(false, false, true)).toBe(29)
    expect(ddlVersionToRecord(false, false, true, true)).toBe(29)
  })

  it('keeps the version below v29 when the ADD INDEX failed, whatever happened to v30 and v31', () => {
    expect(ddlVersionToRecord(false, true)).toBe(28)
    expect(ddlVersionToRecord(false, true, true)).toBe(28)
    expect(ddlVersionToRecord(false, true, false, true)).toBe(28)
  })

  it('keeps the version below v28 when that ALTER failed, whatever happened to v29, v30 and v31', () => {
    expect(ddlVersionToRecord(true)).toBe(27)
    expect(ddlVersionToRecord(true, false)).toBe(27)
    expect(ddlVersionToRecord(true, true)).toBe(27)
    expect(ddlVersionToRecord(true, false, true)).toBe(27)
    expect(ddlVersionToRecord(true, false, false, true)).toBe(27)
  })
})
