import { createClient } from '@clickhouse/client'
import { buildLoginTypeExpression } from '../lib/login-type'

async function main() {
  const client = createClient({
    url: 'http://localhost:8123',
    database: 'ulp',
    username: 'default',
    password: '',
  })

  const expr = buildLoginTypeExpression()
  console.log(`Expression:\n${expr}\n`)

  console.log('Adding login_type as MATERIALIZED column...')
  await client.exec({
    query: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS login_type LowCardinality(String) MATERIALIZED ${expr}`,
  })
  console.log('Column added.')

  console.log('Triggering MATERIALIZE COLUMN backfill...')
  client.exec({ query: 'ALTER TABLE ulp.credentials MATERIALIZE COLUMN login_type' }).catch(e => {
    console.warn('Materialize note:', String(e).substring(0, 200))
  })

  // Confirm schema
  const desc = await client.query({
    query: `SELECT name, type, default_kind FROM system.columns WHERE table='credentials' AND database='ulp' AND name='login_type'`,
    format: 'JSONEachRow',
  })
  console.log('Schema:', JSON.stringify((await desc.json())[0]))

  // Wait for mutation and show distribution
  let attempt = 0
  while (attempt < 20) {
    attempt++
    const res = await client.query({
      query: `SELECT count() as n FROM system.mutations WHERE table='credentials' AND database='ulp' AND is_done=0`,
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ n: string }>()
    if (Number(rows[0]?.n) === 0) { console.log(`Backfill done (${attempt * 2}s)`); break }
    process.stdout.write(`${attempt * 2}s pending... `)
    await new Promise(r => setTimeout(r, 2000))
  }

  const dist = await client.query({
    query: `SELECT login_type, count() as n FROM ulp.credentials GROUP BY login_type ORDER BY n DESC`,
    format: 'JSONEachRow',
  })
  const rows = await dist.json<{ login_type: string; n: string }>()
  const total = rows.reduce((s, r) => s + Number(r.n), 0)
  console.log('\nFinal login_type distribution:')
  for (const r of rows) {
    const pct = (Number(r.n) / total * 100).toFixed(2)
    console.log(`  ${(r.login_type || '(empty)').padEnd(10)} ${Number(r.n).toLocaleString().padStart(12)}  (${pct}%)`)
  }

  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
