/**
 * Idempotent ClickHouse DDL migrations.
 * Called once at startup from the upload route.
 * All statements use IF NOT EXISTS / IF EXISTS so re-running is safe.
 */
import { getClient } from './clickhouse'
import { buildCountryTierExpression } from './country-tiers'
import { buildLoginTypeExpression } from './login-type'
import { buildFreeWebmailInClause } from './webmail-providers'
import { dbGet, dbRun } from './sqlite'

// Per-process guard (still useful to avoid redundant calls within one process)
let migrationsDone = false

// Schema-migration version — bump this to re-run the DDL block on next startup.
// The data-repair mutations have their own separate persistence gate below.
const DDL_VERSION = 1

// Per-version persistence: stored in SQLite app_settings.
// Key: 'ch_ddl_version' — value: last completed DDL_VERSION.
// Key: 'ch_repair_mutations_fired' — value: '1' once the 5 data-repair
//   mutations have been dispatched (they run in background; we only fire
//   them once across all cold-starts, not on every boot).
function getSettingInt(key: string, defaultVal: number): number {
  try {
    const row = dbGet(`SELECT value FROM app_settings WHERE key = ?`, [key]) as { value: string } | undefined
    return row ? parseInt(row.value, 10) : defaultVal
  } catch { return defaultVal }
}
function setSetting(key: string, value: string): void {
  try { dbRun(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]) } catch {}
}

export async function runClickHouseMigrations(): Promise<void> {
  if (migrationsDone) return
  migrationsDone = true

  const lastDdl = getSettingInt('ch_ddl_version', 0)

  const client = getClient()

  const countryTierExpr  = buildCountryTierExpression()
  const loginTypeExpr    = buildLoginTypeExpression()
  const freeWebmailIn    = buildFreeWebmailInClause()

  const migrations: Array<{ sql: string; materialize?: string }> = [
    // breach_name column
    { sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS breach_name String DEFAULT ''` },
    // tld materialized column
    { sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS tld String MATERIALIZED topLevelDomain(url)` },
    // country_tier — dual-signal (email TLD/ISP + URL TLD fallback)
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS country_tier LowCardinality(String) MATERIALIZED ${countryTierExpr}`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN country_tier`,
    },
    // login_type — email / phone / username / empty classification
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS login_type LowCardinality(String) MATERIALIZED ${loginTypeExpr}`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN login_type`,
    },
    // login_type expression fix — update existing installs with corrected dot-after-@ check.
    // MODIFY COLUMN is idempotent; it updates the stored expression even if the column exists.
    // The old expression used positionCaseInsensitive(email, '.') which finds the FIRST dot
    // anywhere in the string — emails like john.doe@gmail.com were misclassified as 'username'
    // because the local-part dot (pos 5) is before the @ (pos 9).
    // New expression: position(email, '.', position(email, '@') + 1) finds a dot AFTER the @.
    {
      sql: `ALTER TABLE ulp.credentials MODIFY COLUMN login_type LowCardinality(String) MATERIALIZED ${loginTypeExpr}`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN login_type`,
    },
    // password_length — length in bytes (fast password-strength analytics)
    { sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS password_length UInt8 MATERIALIZED length(password)` },
    // password_mask — structural classification: alpha/numeric/alphanumeric/mixed/empty
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS password_mask LowCardinality(String) MATERIALIZED multiIf(length(password)=0,'empty',match(password,'^[0-9]+$'),'numeric',match(password,'^[a-zA-Z]+$'),'alpha',match(password,'^[a-zA-Z0-9]+$'),'alphanumeric','mixed')`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN password_mask`,
    },
    // email_domain — lowercased domain portion of email (part after last @)
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS email_domain String MATERIALIZED lower(if(position(email,'@')>0,splitByChar('@',email)[-1],''))`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN email_domain`,
    },
    // url_scheme — http / https / empty (protocol() native function)
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS url_scheme LowCardinality(String) MATERIALIZED multiIf(startsWith(lower(url),'https://'),'https',startsWith(lower(url),'http://'),'http','')`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN url_scheme`,
    },
    // is_corporate_email — 1 when email is not a free/consumer provider
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS is_corporate_email UInt8 MATERIALIZED toUInt8(position(email,'@')>1 AND position(email,' ')=0 AND length(splitByChar('@',lower(email))[-1])>3 AND splitByChar('@',lower(email))[-1] NOT IN (${freeWebmailIn}))`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN is_corporate_email`,
    },
    // is_corporate_email refresh — update when webmail-providers list expands
    {
      sql: `ALTER TABLE ulp.credentials MODIFY COLUMN is_corporate_email UInt8 MATERIALIZED toUInt8(position(email,'@')>1 AND position(email,' ')=0 AND length(splitByChar('@',lower(email))[-1])>3 AND splitByChar('@',lower(email))[-1] NOT IN (${freeWebmailIn}))`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN is_corporate_email`,
    },
    // url_host — hostname extracted from URL, lowercased; falls back to domain column
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS url_host String MATERIALIZED lower(if(url='',domain,replaceRegexpOne(url,'^https?://([^/?#:]+).*$','\\\\1')))`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN url_host`,
    },
    // password_entropy_band — rough strength tier (very_weak / weak / moderate / strong / long)
    {
      sql: `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS password_entropy_band LowCardinality(String) MATERIALIZED multiIf(length(password)=0,'very_weak',length(password)<=4,'very_weak',length(password)<=8,'weak',length(password)<=12 AND match(password,'^[a-zA-Z0-9]+$'),'moderate',length(password)<=12 AND match(password,'[^a-zA-Z0-9]'),'strong',length(password)<=20 AND match(password,'^[a-zA-Z0-9]+$'),'moderate',length(password)<=20 AND match(password,'[^a-zA-Z0-9]'),'strong',length(password)>20,'long','moderate')`,
      materialize: `ALTER TABLE ulp.credentials MATERIALIZE COLUMN password_entropy_band`,
    },
    // skip indexes for new columns (ADD IF NOT EXISTS is not supported for indexes;
    // errors are swallowed by the migration runner if the index already exists)
    { sql: `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_url_host url_host TYPE bloom_filter(0.01) GRANULARITY 1` },
    { sql: `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_email_domain email_domain TYPE bloom_filter(0.01) GRANULARITY 1` },
    { sql: `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_set_password_entropy password_entropy_band TYPE set(0) GRANULARITY 1` },

    // ── Table-level performance settings (safe on existing tables) ──────────
    // MODIFY SETTING is idempotent and takes effect immediately without data
    // rewrite.  Matches the settings in the init SQL for new installations.
    //
    //  parts_to_delay_insert / parts_to_throw_insert — raised from 150/300 to
    //    500/1000 so bulk imports don't stall on "Too many parts" errors.
    //  max_parts_in_total — safety ceiling for the whole table.
    //  min_bytes_for_wide_part / min_rows_for_wide_part — keep small parts in
    //    compact format; write to wide (columnar) format only for large parts.
    {
      sql: `ALTER TABLE ulp.credentials MODIFY SETTING
              parts_to_delay_insert   = 500,
              parts_to_throw_insert   = 1000,
              max_parts_in_total      = 100000,
              min_bytes_for_wide_part = 10485760,
              min_rows_for_wide_part  = 1000000`,
    },
  ]

  // Only run DDL if this version hasn't been applied yet.
  // ADD COLUMN IF NOT EXISTS / MODIFY SETTING are idempotent, but firing
  // MATERIALIZE COLUMN on every cold-start queues background mutations that
  // re-write column data even when nothing changed — expensive at 1.6B rows.
  if (lastDdl < DDL_VERSION) {
    for (const { sql, materialize } of migrations) {
      try {
        await client.exec({ query: sql })
        if (materialize) {
          // Fire-and-forget: mutation runs in the background
          client.exec({ query: materialize }).catch(err => {
            console.warn('[ClickHouse migration] MATERIALIZE COLUMN non-fatal:', String(err).substring(0, 120))
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('column with this name already exists') && !msg.includes('DUPLICATE_COLUMN')) {
          console.warn('[ClickHouse migration] Non-fatal error:', msg.substring(0, 120))
        }
      }
    }
    setSetting('ch_ddl_version', String(DDL_VERSION))
    console.log(`[ClickHouse migration] DDL v${DDL_VERSION} applied`)
  } else {
    console.log(`[ClickHouse migration] DDL v${DDL_VERSION} already applied — skipping`)
  }

  // ── Data-repair mutations (fire-and-forget, run exactly once) ────────────
  // These fix rows that were mis-parsed before the ULP parser was patched.
  // Safe to re-run: WHERE clauses only match corrupted rows, so on already-clean
  // data they match zero rows and ClickHouse completes them instantly.
  //
  // Gate: only fire once ever (not on every cold-start).
  // The WHERE clauses match corrupted rows only, but at 1.6B rows even a
  // zero-match mutation rewrites parts and uses CPU.
  const repairFired = getSettingInt('ch_repair_mutations_fired', 0)
  if (repairFired >= 1) {
    console.log('[ClickHouse migration] data-repair mutations already fired — skipping')
    return
  }
  setSetting('ch_repair_mutations_fired', '1')
  console.log('[ClickHouse migration] firing data-repair mutations (one-time)')

  // Case A — jsessionid bank-log rows
  //   Before fix: email=jsessionid=TOKEN:SRV:USER:PASS  password=IN https://URL  url=''
  //   After fix : url=https://URL  email=USER  password=PASS  domain=from URL
  client.exec({
    query: `ALTER TABLE ulp.credentials UPDATE
              url      = trimLeft(replaceRegexpOne(password, '^[A-Za-z]{1,3}\\\\s+', '')),
              domain   = replaceRegexpOne(domain(trimLeft(replaceRegexpOne(password, '^[A-Za-z]{1,3}\\\\s+', ''))), '^www\\\\.', ''),
              email    = arrayElement(splitByChar(':', email), -2),
              password = arrayElement(splitByChar(':', email), -1)
            WHERE url = ''
              AND lower(left(email, 11)) = 'jsessionid='
              AND match(password, '^[A-Za-z]{1,3}\\\\s+https?://')`,
  }).catch(err => {
    console.warn('[ClickHouse migration] jsessionid repair non-fatal:', String(err).substring(0, 180))
  })

  // Case B — country-code prefix leaked into the url column
  //   Before fix: url='CC https://site.com'  (CC prefix not stripped)
  //   After fix : url='https://site.com'  domain=site.com
  client.exec({
    query: `ALTER TABLE ulp.credentials UPDATE
              url    = trimLeft(replaceRegexpOne(url, '^[A-Za-z]{1,3}\\\\s+', '')),
              domain = replaceRegexpOne(domain(trimLeft(replaceRegexpOne(url, '^[A-Za-z]{1,3}\\\\s+', ''))), '^www\\\\.', '')
            WHERE match(url, '^[A-Za-z]{1,3}\\\\s+https?://')
              AND position(url, '@') = 0`,
  }).catch(err => {
    console.warn('[ClickHouse migration] CC-prefix repair non-fatal:', String(err).substring(0, 180))
  })

  // Case C — URL scheme split from rest; path+login merged into the email column
  //   Before fix: url='https'  email='//host/path username'  domain='https'
  //   After fix : url='https://host/path'  email='username'  domain='host'
  client.exec({
    query: `ALTER TABLE ulp.credentials UPDATE
              url    = concat(url, ':', splitByChar(' ', email)[1]),
              domain = replaceRegexpOne(domain(concat(url, ':', splitByChar(' ', email)[1])), '^www\\\\.', ''),
              email  = splitByChar(' ', email)[2]
            WHERE url IN ('http', 'https')
              AND startsWith(email, '//')
              AND position(email, ' ') > 0`,
  }).catch(err => {
    console.warn('[ClickHouse migration] scheme-split repair non-fatal:', String(err).substring(0, 180))
  })

  // Case D — URL contained embedded user-info (https://user@host)
  //   Before fix: url='https://user@gmail.com'  email='user@gmail.com' (wrong — email is the
  //               same as what was in the URL, or worse stored incorrectly)
  //   The new parser extracts email from URL user-info at import time, so this mutation
  //   only needs to handle rows where the email column still holds a full URL.
  //   Pattern: email starts with 'https://' or 'http://' → it's a URL stored in email slot.
  //   Fix: clear url, derive domain from email domain part (@ suffix), email stays as URL.
  //   These rows were unusable anyway — mark url='' so they display without a fake domain.
  client.exec({
    query: `ALTER TABLE ulp.credentials UPDATE
              url    = '',
              domain = if(position(email, '@') > 0,
                          replaceRegexpOne(splitByChar('@', email)[-1], '^www\\.', ''),
                          domain)
            WHERE match(email, '^https?://')`,
  }).catch(err => {
    console.warn('[ClickHouse migration] url-in-email repair non-fatal:', String(err).substring(0, 180))
  })

  // Case E — "junk URL" hostname with no valid TLD stored in url column
  //   (e.g. url='https://roba.nikolas', url='https://qKLhbA5CMpz56')
  //   The new parser rejects these at import time.  For existing rows, clear the url
  //   field so the domain column derives from email instead, avoiding fake domains
  //   like 'roba.nikolas' or 'qklhba5cmpz56' appearing in stats/search.
  //
  //   Detection heuristic: url host has no dot (single-label) or TLD is longer than
  //   6 chars (not a valid gTLD or CC).  ClickHouse's domain() function extracts the
  //   host; topLevelDomain() extracts the TLD for further validation.
  client.exec({
    query: `ALTER TABLE ulp.credentials UPDATE
              url    = '',
              domain = if(position(email, '@') > 0,
                          replaceRegexpOne(splitByChar('@', email)[-1], '^www\\.', ''),
                          '')
            WHERE url != ''
              AND match(url, '^https?://')
              AND (
                position(domain(url), '.') = 0
                OR length(topLevelDomain(url)) > 6
              )`,
  }).catch(err => {
    console.warn('[ClickHouse migration] junk-url repair non-fatal:', String(err).substring(0, 180))
  })
}
