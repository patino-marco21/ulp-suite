/**
 * Fix two classes of field-swap corruption in ulp.credentials.
 *
 * ── Case A — jsessionid rows ──────────────────────────────────────────────────
 *   Root cause:  The old ULP parser's looksLikeEmail() accepted any string
 *                containing "@" — including jsessionid tokens that embed a
 *                password ending in garbage like "@#$".
 *
 *   Raw format:  jsessionid=TOKEN:SERVER:USERNAME:PASSWORD\tCC https://URL
 *   Stored as:   url=""   email=<jsessionid string>   password=<CC https://URL>
 *   Fix to:      url=<URL>   email=<USERNAME>   password=<PASSWORD>
 *
 * ── Case B — CC URL rows ──────────────────────────────────────────────────────
 *   Root cause:  Lines like "BD https://host/path:login:pass|noise|noise" were
 *                split on "|" before the CC prefix was stripped; the first
 *                pipe-field ended up stored verbatim as the "url" column.
 *
 *   Stored as:   url=<CC https://host:login:pass>   email=<noise1>   password=<noise2>
 *   Fix to:      url=<https://host/path>   email=<login>   password=<pass>
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npx tsx scripts/fix-field-swaps.ts            # dry-run (count + preview)
 *   npx tsx scripts/fix-field-swaps.ts --apply    # apply mutations
 *
 * Both cases use ALTER TABLE ... UPDATE (ClickHouse lightweight mutations).
 * All RHS column references in the UPDATE expressions refer to the ORIGINAL
 * (pre-mutation) values, so cross-column references are safe.
 */

import { createClient } from '@clickhouse/client'

// ─── Connection ───────────────────────────────────────────────────────────────

const client = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
  database: process.env.CLICKHOUSE_DATABASE ?? process.env.CLICKHOUSE_DB ?? 'ulp',
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function query<T>(sql: string): Promise<T[]> {
  const rs = await client.query({ query: sql, format: 'JSONEachRow' })
  return rs.json<T>()
}

async function exec(sql: string): Promise<void> {
  await client.exec({ query: sql })
}

/** Poll system.mutations until all pending mutations on ulp.credentials finish */
async function waitForMutations(label: string, timeoutSeconds = 600): Promise<void> {
  const start = Date.now()
  process.stdout.write(`  Waiting for mutation to finish`)
  while (Date.now() - start < timeoutSeconds * 1000) {
    const rows = await query<{ n: string }>(
      `SELECT count() AS n FROM system.mutations
       WHERE database = 'ulp' AND table = 'credentials' AND is_done = 0`
    )
    if (Number(rows[0]?.n ?? 0) === 0) {
      console.log(' ✅')
      return
    }
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 3000))
  }
  console.log(` ⚠️  timeout after ${timeoutSeconds}s — mutation may still be running`)
}

// ─── Case A: jsessionid rows ──────────────────────────────────────────────────

const CASE_A_WHERE = `
  url = ''
  AND lower(left(email, 11)) = 'jsessionid='
  AND match(password, '^[A-Z]{0,3}\\s*https?://')
`.trim()

/**
 * Strip "BD " / "IN " / etc. from a CC-prefixed URL in ClickHouse SQL.
 * replaceRegexpOne(col, '^[A-Z]{1,3}\\s+', '')
 */
const stripCC = (col: string) =>
  `replaceRegexpOne(${col}, '^[A-Z]{1,3}\\\\s+', '')`

/**
 * For a jsessionid=TOKEN:SERVER:USERNAME:PASSWORD string:
 *   inner = TOKEN:SERVER:USERNAME:PASSWORD
 *   parts = splitByChar(':', inner)
 *   username = parts[-2]   password = parts[-1]
 */
const jsessInner = (col: string) =>
  `replaceRegexpOne(${col}, '^jsessionid=', '')`

const jsessUsername = (col: string) =>
  `arrayElement(splitByChar(':', ${jsessInner(col)}), -2)`

const jsessPassword = (col: string) =>
  `arrayElement(splitByChar(':', ${jsessInner(col)}), -1)`

/** Extract hostname from a URL (strips protocol + trailing path) */
const extractHostFromURL = (urlExpr: string) =>
  `replaceRegexpOne(${urlExpr}, '^https?://([^/?#:]+).*$', '\\\\1')`

async function countCaseA(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count() AS n FROM ulp.credentials WHERE ${CASE_A_WHERE}`
  )
  return Number(rows[0]?.n ?? 0)
}

async function previewCaseA(limit = 5): Promise<void> {
  const rows = await query<{ email: string; password: string }>(
    `SELECT email, password FROM ulp.credentials WHERE ${CASE_A_WHERE} LIMIT ${limit}`
  )
  for (const r of rows) {
    const inner = r.email.replace(/^jsessionid=/i, '')
    const parts = inner.split(':')
    const username = parts.at(-2) ?? '?'
    const password = parts.at(-1) ?? '?'
    const url = r.password.replace(/^[A-Z]{1,3}\s+/, '')
    console.log(`    email stored: ${r.email.slice(0, 60)}`)
    console.log(`    → url=${url}  email=${username}  password=${password}`)
    console.log()
  }
}

async function applyCaseA(): Promise<void> {
  const newUrl      = stripCC('password')
  const newEmail    = jsessUsername('email')
  const newPassword = jsessPassword('email')
  const newDomain   = extractHostFromURL(stripCC('password'))

  const sql = `
    ALTER TABLE ulp.credentials UPDATE
      url      = ${newUrl},
      email    = ${newEmail},
      password = ${newPassword},
      domain   = ${newDomain}
    WHERE ${CASE_A_WHERE}
  `
  await exec(sql)
}

// ─── Case B: CC URL rows ──────────────────────────────────────────────────────

const CASE_B_WHERE = `
  match(url, '^[A-Z]{1,3} https?://')
  AND position(url, '@') > 0
`.trim()

/**
 * The url column contains: "BD https://host/path:login:pass"
 *
 * After stripping CC prefix: "https://host/path:login:pass"
 * Split by ':' → ['https', '//host/path', 'login', 'pass']
 *   real_url      = parts[1] + ':' + parts[2]   = "https://host/path"
 *   real_email    = parts[3]                     = "login"
 *   real_password = parts[4..] joined by ':'     = "pass"   (handles colons in password)
 *   real_domain   = extract host from //host/path
 */
const caseBStripped = stripCC('url')  // replaceRegexpOne(url, ...)
const caseBParts    = `splitByString(':', ${caseBStripped})`

const caseBUrl      = `concat(${caseBParts}[1], ':', ${caseBParts}[2])`
const caseBEmail    = `${caseBParts}[3]`
const caseBPassword = `arrayStringConcat(arraySlice(${caseBParts}, 4), ':')`
// The domain extraction for Case B is from the //host/path segment (parts[2]),
// not from a full URL.  So we just strip the leading "//".
const caseBDomainFixed = `replaceRegexpOne(${caseBParts}[2], '^//', '')`
  // e.g., "//accounts.nike.com/join" → "accounts.nike.com/join"
  // then strip path:
const caseBDomainFinal = `replaceRegexpOne(${caseBDomainFixed}, '/.*$', '')`

async function countCaseB(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count() AS n FROM ulp.credentials WHERE ${CASE_B_WHERE}`
  )
  return Number(rows[0]?.n ?? 0)
}

async function previewCaseB(limit = 5): Promise<void> {
  const rows = await query<{ url: string; email: string; password: string }>(
    `SELECT url, email, password FROM ulp.credentials WHERE ${CASE_B_WHERE} LIMIT ${limit}`
  )
  for (const r of rows) {
    const stripped = r.url.replace(/^[A-Z]{1,3}\s+/, '')
    const parts = stripped.split(':')
    const realUrl      = `${parts[0]}:${parts[1]}`
    const realEmail    = parts[2] ?? ''
    const realPassword = parts.slice(3).join(':')
    console.log(`    url stored: ${r.url.slice(0, 70)}`)
    console.log(`    → url=${realUrl}  email=${realEmail}  password=${realPassword}`)
    console.log()
  }
}

async function applyCaseB(): Promise<void> {
  const sql = `
    ALTER TABLE ulp.credentials UPDATE
      url      = ${caseBUrl},
      email    = ${caseBEmail},
      password = ${caseBPassword},
      domain   = ${caseBDomainFinal}
    WHERE ${CASE_B_WHERE}
  `
  await exec(sql)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes('--apply')

  console.log('=== fix-field-swaps ===')
  console.log(apply ? '  MODE: APPLY (mutations will be written)' : '  MODE: DRY RUN (pass --apply to mutate)')
  console.log()

  // ── Case A ──
  console.log('── Case A: jsessionid rows ─────────────────────────────────────')
  const countA = await countCaseA()
  console.log(`  Affected rows: ${countA.toLocaleString()}`)
  if (countA > 0) {
    console.log('  Sample (before → after):')
    await previewCaseA(3)
  }

  if (apply && countA > 0) {
    process.stdout.write('  Applying Case A mutation... ')
    await applyCaseA()
    console.log('✅ mutation submitted')
    await waitForMutations('Case A')
    const remaining = await countCaseA()
    console.log(`  Remaining after fix: ${remaining.toLocaleString()}`)
  }

  // ── Case B ──
  console.log('── Case B: CC URL rows ─────────────────────────────────────────')
  const countB = await countCaseB()
  console.log(`  Affected rows: ${countB.toLocaleString()}`)
  if (countB > 0) {
    console.log('  Sample (before → after):')
    await previewCaseB(3)
  }

  if (apply && countB > 0) {
    process.stdout.write('  Applying Case B mutation... ')
    await applyCaseB()
    console.log('✅ mutation submitted')
    await waitForMutations('Case B')
    const remaining = await countCaseB()
    console.log(`  Remaining after fix: ${remaining.toLocaleString()}`)
  }

  // ── Summary ──
  console.log()
  if (!apply) {
    console.log(`Total rows to fix: ${(countA + countB).toLocaleString()}`)
    console.log('Run with --apply to mutate: npx tsx scripts/fix-field-swaps.ts --apply')
  } else {
    console.log('✅ fix-field-swaps complete')
  }

  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
