/**
 * Adds 5 new MATERIALIZED columns to ulp.credentials and backfills them.
 *
 *   password_length   UInt8                  — length(password)
 *   password_mask     LowCardinality(String)  — alpha/numeric/alphanumeric/mixed/empty
 *   email_domain      String                  — part after @ (lowercase)
 *   url_scheme        LowCardinality(String)  — protocol() native function
 *   is_corporate_email UInt8                  — 1 if not a free/consumer webmail provider
 *
 * Run: node_modules/.bin/tsx scripts/migrate-new-columns.ts
 */
import { createClient } from '@clickhouse/client'
import { buildFreeWebmailInClause } from '../lib/webmail-providers'

async function main() {
  const client = createClient({
    url: 'http://localhost:8123',
    database: 'ulp',
    username: 'default',
    password: '',
  })

  const freeWebmailIn = buildFreeWebmailInClause()

  const columns: Array<{ name: string; sql: string }> = [
    {
      name: 'password_length',
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS password_length UInt8 MATERIALIZED length(password)`,
    },
    {
      name: 'password_mask',
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS password_mask LowCardinality(String) MATERIALIZED multiIf(
        length(password) = 0,              'empty',
        match(password, '^[0-9]+$'),       'numeric',
        match(password, '^[a-zA-Z]+$'),    'alpha',
        match(password, '^[a-zA-Z0-9]+$'), 'alphanumeric',
        'mixed'
      )`,
    },
    {
      name: 'email_domain',
      // splitByChar + [-1] gives the part after the LAST @; fastest, no regex overhead
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS email_domain String MATERIALIZED lower(if(position(email, '@') > 0, splitByChar('@', email)[-1], ''))`,
    },
    {
      name: 'url_scheme',
      // protocol() is a native ClickHouse URL function — returns 'http', 'https', etc.
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS url_scheme LowCardinality(String) MATERIALIZED multiIf(startsWith(lower(url), 'https://'), 'https', startsWith(lower(url), 'http://'), 'http', '')`,
    },
    {
      name: 'is_corporate_email',
      // 1 when email has a valid @ structure AND the domain is not a known free/consumer provider
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS is_corporate_email UInt8 MATERIALIZED toUInt8(
        position(email, '@') > 1
        AND position(email, ' ') = 0
        AND length(splitByChar('@', lower(email))[-1]) > 3
        AND splitByChar('@', lower(email))[-1] NOT IN (${freeWebmailIn})
      )`,
    },
  ]

  console.log('=== migrate-new-columns ===\n')

  for (const { name, sql } of columns) {
    process.stdout.write(`Adding ${name}... `)
    try {
      await client.exec({ query: sql })
      console.log('✅ column added')
    } catch (e) {
      const msg = String(e)
      if (msg.includes('already exists') || msg.includes('DUPLICATE_COLUMN')) {
        console.log('⏭  already exists')
      } else {
        console.error('❌ error:', msg.substring(0, 200))
      }
    }

    // Fire MATERIALIZE COLUMN and wait for it to complete
    process.stdout.write(`  Materializing ${name}... `)
    try {
      await client.exec({ query: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN ${name}` })
      // Poll until the mutation finishes
      let done = false
      for (let i = 0; i < 60 && !done; i++) {
        const r = await client.query({
          query: `SELECT count() AS n FROM system.mutations WHERE table='credentials' AND database='ulp' AND is_done=0`,
          format: 'JSONEachRow',
        })
        const rows = await r.json<{ n: string }>()
        if (Number(rows[0]?.n) === 0) { done = true; break }
        process.stdout.write(`${(i + 1) * 2}s `)
        await new Promise(r => setTimeout(r, 2000))
      }
      console.log(done ? '✅ done' : '⚠️  timed out (mutation may still be running)')
    } catch (e) {
      console.warn('  ⚠️  materialize note:', String(e).substring(0, 150))
    }
  }

  // Show final schema for these columns
  const desc = await client.query({
    query: `SELECT name, type, default_kind, default_expression
            FROM system.columns
            WHERE table='credentials' AND database='ulp'
            AND name IN ('password_length','password_mask','email_domain','url_scheme','is_corporate_email')
            ORDER BY position`,
    format: 'JSONEachRow',
  })
  const schema = await desc.json<Record<string, string>>()
  console.log('\n=== Schema ===')
  for (const col of schema) {
    console.log(`  ${col.name.padEnd(22)} ${col.type.padEnd(30)} [${col.default_kind}]`)
  }

  // Show sample distributions
  console.log('\n=== Distributions ===')

  for (const [col, label] of [
    ['password_mask', 'Password mask'],
    ['url_scheme', 'URL scheme'],
  ] as const) {
    const r = await client.query({
      query: `SELECT ${col} AS v, count() AS n FROM ulp.credentials GROUP BY v ORDER BY n DESC`,
      format: 'JSONEachRow',
    })
    const rows = await r.json<{ v: string; n: string }>()
    const total = rows.reduce((s, row) => s + Number(row.n), 0)
    console.log(`\n  ${label}:`)
    for (const row of rows) {
      const pct = (Number(row.n) / total * 100).toFixed(1)
      console.log(`    ${(row.v || '(empty)').padEnd(14)} ${Number(row.n).toLocaleString().padStart(10)}  (${pct}%)`)
    }
  }

  const corpR = await client.query({
    query: `SELECT sum(is_corporate_email) AS corp, count() AS total FROM ulp.credentials WHERE login_type = 'email'`,
    format: 'JSONEachRow',
  })
  const corpRows = await corpR.json<{ corp: string; total: string }>()
  if (corpRows[0]) {
    const corp = Number(corpRows[0].corp)
    const total = Number(corpRows[0].total)
    console.log(`\n  Corporate emails (of real email logins): ${corp.toLocaleString()} / ${total.toLocaleString()} (${(corp / total * 100).toFixed(1)}%)`)
  }

  await client.close()
  console.log('\n✅ Migration complete')
}

main().catch(e => { console.error(e); process.exit(1) })
