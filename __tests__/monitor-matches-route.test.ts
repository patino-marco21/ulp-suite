import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('monitor matches route — bounded unordered snapshot (MEMORY_LIMIT_EXCEEDED regression)', () => {
  const source = readFileSync(new URL('../app/api/monitoring/monitors/[id]/matches/route.ts', import.meta.url), 'utf8')
  const getFn = source.slice(source.indexOf('export async function GET'))

  test('does not sort the filtered set before LIMIT', () => {
    expect(getFn).not.toMatch(/ORDER BY/i)
  })

  test('caps the query with a named LIMIT constant', () => {
    expect(source).toMatch(/MATCH_LIMIT\s*=\s*100/)
    expect(getFn).toContain('LIMIT {matchLimit:UInt32}')
  })

  test('sets an execution-time guard', () => {
    expect(getFn).toContain('max_execution_time = 60')
    expect(getFn).toContain(`timeout_overflow_mode = 'throw'`)
  })

  test('builds the WHERE clause from the shared multi-domain builder', () => {
    expect(source).toContain('buildDomainSetWhereClause(monitor.domains, monitor.match_mode)')
  })

  test('requires authentication but not admin', () => {
    expect(getFn).toContain('validateRequest(request)')
    expect(getFn).not.toContain('requireAdminRole')
  })
})
