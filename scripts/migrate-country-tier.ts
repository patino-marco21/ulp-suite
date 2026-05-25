import { createClient } from '@clickhouse/client'
import { buildCountryTierExpression } from '../lib/country-tiers'

async function main() {
  const client = createClient({
    url: 'http://localhost:8123',
    database: 'ulp',
    username: 'default',
    password: '',
  })

  const expr = buildCountryTierExpression()
  console.log(`Expression length: ${expr.length} chars`)

  // Drop any existing placeholder column (DEFAULT '' from prior attempt)
  console.log('Dropping old placeholder column if present...')
  await client.exec({ query: 'ALTER TABLE ulp.credentials DROP COLUMN IF EXISTS country_tier' })

  // Re-add as MATERIALIZED — computed from email + tld at insert time
  console.log('Adding country_tier as MATERIALIZED column...')
  await client.exec({
    query: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS country_tier LowCardinality(String) MATERIALIZED ${expr}`,
  })
  console.log('MATERIALIZED column added successfully.')

  // Kick off backfill mutation — async, runs in background
  console.log('Triggering MATERIALIZE COLUMN for backfill of existing 1.59M rows...')
  // Don't await — this mutation can take 10–30s on a local machine
  client.exec({ query: 'ALTER TABLE ulp.credentials MATERIALIZE COLUMN country_tier' }).catch(e => {
    console.warn('Materialize mutation note:', String(e).substring(0, 200))
  })

  // Verify schema
  const desc = await client.query({
    query: `SELECT name, type, default_kind FROM system.columns
            WHERE table='credentials' AND database='ulp' AND name='country_tier'`,
    format: 'JSONEachRow',
  })
  const rows = await desc.json<{ name: string; type: string; default_kind: string }>()
  console.log('Column confirmed in schema:', JSON.stringify(rows[0]))

  // Quick sanity count — wait 2s for mutation to start
  await new Promise(r => setTimeout(r, 3000))
  const cnt = await client.query({
    query: `SELECT country_tier, count() as n FROM ulp.credentials GROUP BY country_tier ORDER BY n DESC LIMIT 5`,
    format: 'JSONEachRow',
  })
  const counts = await cnt.json<{ country_tier: string; n: string }>()
  console.log('\nEarly tier distribution (mutation may still be running):')
  for (const row of counts) {
    console.log(`  ${row.country_tier || '(untiered)'}: ${Number(row.n).toLocaleString()}`)
  }

  await client.close()
  console.log('\nMigration complete. Backfill mutation running in background.')
}

main().catch(e => { console.error(e); process.exit(1) })
