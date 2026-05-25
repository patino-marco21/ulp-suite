/**
 * Adds skip indexes to ulp.credentials to accelerate common query patterns.
 *
 *   bloom_filter(0.01) on email, domain, password  — fast exact-match point lookups
 *   set(0) on country_tier, login_type, password_mask, url_scheme  — low-cardinality IN() filters
 *   minmax on imported_at  — fast date range pruning
 *
 * NOTE: Run AFTER migrate-new-columns.ts (requires password_mask, url_scheme columns).
 * Run: node_modules/.bin/tsx scripts/migrate-skip-indexes.ts
 */
import { createClient } from '@clickhouse/client'

interface IndexDef {
  name: string
  column: string
  type: string
  granularity: number
}

async function main() {
  const client = createClient({
    url: 'http://localhost:8123',
    database: 'ulp',
    username: 'default',
    password: '',
  })

  const indexes: IndexDef[] = [
    // Bloom filter — fires on = and IN; ideal for email/domain/password point lookups
    { name: 'idx_bf_email',    column: 'email',    type: 'bloom_filter(0.01)', granularity: 1 },
    { name: 'idx_bf_domain',   column: 'domain',   type: 'bloom_filter(0.01)', granularity: 1 },
    { name: 'idx_bf_password', column: 'password', type: 'bloom_filter(0.01)', granularity: 1 },
    // SET — stores all distinct values per granule block; ideal for low-cardinality columns
    { name: 'idx_set_country_tier',  column: 'country_tier',  type: 'set(0)', granularity: 1 },
    { name: 'idx_set_login_type',    column: 'login_type',    type: 'set(0)', granularity: 1 },
    { name: 'idx_set_password_mask', column: 'password_mask', type: 'set(0)', granularity: 1 },
    { name: 'idx_set_url_scheme',    column: 'url_scheme',    type: 'set(0)', granularity: 1 },
    // minmax — fires on range predicates (>, <, BETWEEN); ideal for datetime columns
    { name: 'idx_mm_imported_at', column: 'imported_at', type: 'minmax', granularity: 1 },
  ]

  console.log('=== migrate-skip-indexes ===\n')

  // Check which indexes already exist
  const existingR = await client.query({
    query: `SELECT name FROM system.data_skipping_indices WHERE table='credentials' AND database='ulp'`,
    format: 'JSONEachRow',
  })
  const existing = new Set((await existingR.json<{ name: string }>()).map(r => r.name))
  console.log(`Existing indexes: ${existing.size > 0 ? [...existing].join(', ') : '(none)'}`)

  for (const idx of indexes) {
    if (existing.has(idx.name)) {
      console.log(`⏭  ${idx.name} (${idx.column} TYPE ${idx.type}) — already exists`)
      continue
    }

    process.stdout.write(`Adding ${idx.name} (${idx.column} TYPE ${idx.type})... `)
    try {
      await client.exec({
        query: `ALTER TABLE ulp.credentials ADD INDEX ${idx.name} ${idx.column} TYPE ${idx.type} GRANULARITY ${idx.granularity}`,
      })
      console.log('✅')
    } catch (e) {
      console.error('❌', String(e).substring(0, 200))
      continue
    }

    // MATERIALIZE INDEX builds the index for existing data parts
    process.stdout.write(`  Materializing ${idx.name}... `)
    try {
      // Fire materialize — this is a background mutation
      client.exec({ query: `ALTER TABLE ulp.credentials MATERIALIZE INDEX ${idx.name}` }).catch(e => {
        console.warn('  materialize note:', String(e).substring(0, 100))
      })
      console.log('⏳ running in background')
    } catch (e) {
      console.warn('  ⚠️  materialize note:', String(e).substring(0, 150))
    }
  }

  // Wait for all pending mutations
  console.log('\nWaiting for mutations to complete...')
  for (let i = 0; i < 60; i++) {
    const r = await client.query({
      query: `SELECT count() AS n FROM system.mutations WHERE table='credentials' AND database='ulp' AND is_done=0`,
      format: 'JSONEachRow',
    })
    const rows = await r.json<{ n: string }>()
    const pending = Number(rows[0]?.n)
    if (pending === 0) { console.log(`✅ All mutations complete (${i * 3}s)`); break }
    process.stdout.write(`${i * 3}s pending:${pending} `)
    await new Promise(r => setTimeout(r, 3000))
  }

  // Show final index list
  const finalR = await client.query({
    query: `SELECT name, type, expr, granularity FROM system.data_skipping_indices WHERE table='credentials' AND database='ulp' ORDER BY name`,
    format: 'JSONEachRow',
  })
  const final = await finalR.json<{ name: string; type: string; expr: string; granularity: number }>()
  console.log(`\n=== Skip Indexes on ulp.credentials (${final.length} total) ===`)
  for (const idx of final) {
    console.log(`  ${idx.name.padEnd(28)} ${idx.type.padEnd(20)} on ${idx.expr} (GRANULARITY ${idx.granularity})`)
  }

  await client.close()
  console.log('\n✅ Skip index migration complete')
}

main().catch(e => { console.error(e); process.exit(1) })
