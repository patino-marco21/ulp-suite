import { execSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

/**
 * LIVE, READ-ONLY check of the projection-scope eligibility query on a real ClickHouse of the production version. Skipped unless
 * PS_LIVE=1. It must run, and it may only name partitions that really carry proj_imported_desc, and never the newest one.
 *
 *   PS_LIVE=1 npx vitest run __tests__/projection-scope.live.test.ts
 */
const LIVE = process.env.PS_LIVE === '1'

if (LIVE) {
  const ip = execSync("docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'").toString().trim()
  process.env.CLICKHOUSE_HOST = `http://${ip}:8123`
  process.env.CLICKHOUSE_USER = 'default'
  process.env.CLICKHOUSE_PASSWORD = ''
  process.env.CLICKHOUSE_DATABASE = 'ulp'
}

async function rows<T>(sql: string): Promise<T[]> {
  const { getClient } = await import('@/lib/clickhouse')
  const res = await getClient().query({ query: sql, format: 'JSONEachRow' })
  return (await res.json()) as T[]
}

describe.skipIf(!LIVE)('projection-scope eligibility on the live table', () => {
  test('with the cutoff pushed to the future, it names only partitions that carry the projection, and never the newest', async () => {
    const { buildEligiblePartitionsSql, PROJECTION_NAME } = await import('@/lib/projection-scope')
    const eligible = await rows<{ partition: string; largest_part_bytes: string }>(buildEligiblePartitionsSql('999999'))
    const carrying = new Set(
      (await rows<{ partition: string }>(
        `SELECT DISTINCT partition FROM system.projection_parts WHERE database = 'ulp' AND table = 'credentials' AND name = '${PROJECTION_NAME}' AND active`,
      )).map(r => r.partition),
    )
    const [{ newest }] = await rows<{ newest: string }>(
      "SELECT max(partition) AS newest FROM system.parts WHERE database = 'ulp' AND table = 'credentials' AND active",
    )
    for (const r of eligible) {
      expect(carrying.has(r.partition), `${r.partition} carries the projection`).toBe(true)
      expect(r.partition).not.toBe(newest)
      expect(Number(r.largest_part_bytes)).toBeGreaterThan(0)
    }
  })
})
