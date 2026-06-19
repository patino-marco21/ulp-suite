/**
 * Idempotent ClickHouse DDL migrations.
 * Called once at startup from the upload route.
 * All statements use IF NOT EXISTS / IF EXISTS so re-running is safe.
 */
import { getClient } from './clickhouse'
import { buildCountryTierExpression } from './country-tiers'
import { buildLoginTypeExpression } from './login-type'
import { buildFreeWebmailInClause } from './webmail-providers'
import { NOISE_EXPR } from './ulp-noise'
import { dbGet, dbRun } from './sqlite'

// Per-process guard (still useful to avoid redundant calls within one process)
let migrationsDone = false

// Schema-migration version — bump this to run the new DDL block on next startup.
// The data-repair mutations have their own separate persistence gate below.
// v1: columns + materialized columns + table settings
// v2: additional skip indexes (breach_name + source_file bloom filters)
// v3: MV backing tables (SummingMergeTree + AggregatingMergeTree) + 4 materialized views
// v4: ngrambf_v1(4,1024,1,0) skip indexes on url_host + email_domain (substring search)
// v5: full_text(0) inverted indexes on url/email/password (replace tokenbf_v1; drop unused idx_email_ngram)
//     ⚠️  full_text() type was removed in ClickHouse 26.2 — v5 silently fails on 26.x.
//         The v5 DROPs succeed, leaving the table with no skip indexes on url/email/password.
// v6: re-create the text indexes using the correct ClickHouse 26.x syntax:
//     TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(col))
//     preprocessor = lower(col) matches hasToken(col, lower(value)) in lib/ulp-search.ts.
// v7: idempotent re-verify of the v6 text indexes.
//     On ClickHouse 26.x installs where the user profile had
//     timeout_overflow_mode=break AND use_query_cache=1, every exec() threw
//     error 731 (QUERY_CACHE_USED_WITH_NON_THROW_OVERFLOW_MODE) and the v6
//     DDL silently failed. ch_ddl_version was still saved as 6, so migrations
//     were never retried. v7 forces a re-run using ADD INDEX IF NOT EXISTS so
//     the indexes are created even on boxes that showed v6 as "done" but skipped.
// v9: idx_ngram_url_host / idx_ngram_email_domain (from v4) never took effect on
//     installs where ch_ddl_version was already >= 4 — the `lastDdl < 4` gate is
//     permanently closed for those installs. Without these, position(url_host,...)
//     / position(email_domain,...) in lib/ulp-search.ts have no skip index, and
//     since they're OR'd with the hasToken() conditions, NO pruning happens at all
//     (verified via EXPLAIN: "Combined skip indexes: 800/800" even for a unique
//     token). v9 unconditionally (re)adds both ngram indexes, and drops the legacy
//     tokenbf_v1 indexes (idx_url/idx_email/idx_password) + idx_email_ngram that v5
//     intended to remove but — for the same gate reason — never did on some installs.
// v10: Reuse/Similar/Stats pages and APIs removed from the app. Drops the 4 MV
//     backing tables from v3/v8 (ulp.domain_counts, ulp.password_counts,
//     ulp.url_host_counts, ulp.reuse_pairs) and their 4 materialized views
//     (mv_domain_counts, mv_password_counts, mv_url_host_counts, mv_reuse_pairs),
//     which were only read by the now-deleted /api/reuse, /api/stats, and
//     /api/admin/rebuild-mv. Views are dropped before their backing tables to
//     avoid a race where a view tries to write to an already-dropped table.
//     The materialized COLUMNS these MVs read from (country_tier, login_type,
//     password_mask, etc.) are untouched — /credentials still filters on them.
// v11: Retry the v10 drops. During the 2026-06-12/13 data-loss incident,
//     ulp.domain_counts had 7 "broken-on-start" parts (TOO_MANY_UNEXPECTED_DATA_PARTS)
//     at the time v10 ran, so it failed to load — DROP VIEW ulp.mv_domain_counts and
//     DROP TABLE ulp.domain_counts both threw, caught as non-fatal by runMigration(),
//     but ch_ddl_version was still bumped to 10, so v10 never retried.
//     force_restore_data has since detached those broken parts, so domain_counts now
//     loads fine and the drops should succeed. Repeats all 8 v10 drops (not just the
//     2 that failed) for idempotent safety — every statement is IF EXISTS, so
//     re-dropping already-gone objects is a harmless no-op.
// v12: is_noise UInt8 MATERIALIZED column for the browser's default-on "Declutter"
//     filter. Flags low-signal rows (IP-host / :port / .php / localhost URLs — see
//     lib/ulp-noise.ts NOISE_EXPR). The filter was first shipped as an inline WHERE
//     predicate of non-indexable per-row functions (match/port/isIPv4String) over
//     the wide url/domain columns; on a broad (non-prunable) search it scanned for
//     ~79 s. Precomputing it once at insert turns the query filter into a cheap
//     `is_noise = 0` PREWHERE compare. MATERIALIZE COLUMN backfills existing parts
//     in the background — the speedup lands once that mutation completes.
// v13: broaden is_noise to also flag single-label/no-TLD hosts (http://dev, the
//     'http'/'https'-only scheme-split corruption) and browser/non-web-scheme URLs
//     (chrome://, chrome-extension://, file://, ftp://, data:, javascript:, …) on
//     top of v12's IP/:port/.php/localhost set. MODIFY COLUMN swaps the MATERIALIZED
//     expression; MATERIALIZE COLUMN recomputes existing parts in the background.
const DDL_VERSION = 13

// Per-version persistence: stored in SQLite app_settings.
// Key: 'ch_ddl_version' — value: last completed DDL_VERSION.
// Key: 'ch_repair_mutations_fired' — value: '1' once the 5 data-repair
//   mutations have been dispatched (they run in background; we only fire
//   them once across all cold-starts, not on every boot).
function getSettingInt(key: string, defaultVal: number): number {
  try {
    // app_settings column is key_name (not key) — match lib/sqlite.ts schema
    const row = dbGet(`SELECT value FROM app_settings WHERE key_name = ?`, [key]) as { value: string } | undefined
    return row ? parseInt(row.value, 10) : defaultVal
  } catch { return defaultVal }
}
function setSetting(key: string, value: string): void {
  // app_settings column is key_name (not key) — match lib/sqlite.ts schema
  // description/created_at/updated_at have DEFAULT values in the schema so
  // they are safe to omit from INSERT.
  try { dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, ?)`, [key, value]) } catch {}
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

  // Helper: run one migration + optional background materialize step.
  async function runMigration(sql: string, materialize?: string) {
    try {
      await client.exec({ query: sql })
      if (materialize) {
        client.exec({ query: materialize }).catch(err => {
          console.warn('[ClickHouse migration] MATERIALIZE non-fatal:', String(err).substring(0, 120))
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const benign = msg.includes('column with this name already exists')
                  || msg.includes('DUPLICATE_COLUMN')
                  || msg.includes('already exists')
      if (!benign) console.warn('[ClickHouse migration] Non-fatal error:', msg.substring(0, 120))
    }
  }

  // v1 — columns, materialized columns, table settings (idempotent; only run once).
  // MATERIALIZE COLUMN creates background mutations; skipping on re-runs avoids
  // redundant 1.6B-row rewrites when nothing changed.
  if (lastDdl < 1) {
    for (const { sql, materialize } of migrations) {
      await runMigration(sql, materialize)
    }
    console.warn('[ClickHouse migration] DDL v1 applied')
  }

  // v2 — additional skip indexes for faster WHERE filtering on breach_name + source_file.
  // bloom_filter(0.01) prunes granules that cannot contain the queried value, giving
  // 10–100× speedup for the common breach_name = ? and source_file = ? filter patterns.
  // MATERIALIZE INDEX rebuilds the index for existing data (fire-and-forget mutation).
  if (lastDdl < 2) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_breach_name breach_name TYPE bloom_filter(0.01) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_breach_name`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_bf_source_file source_file TYPE bloom_filter(0.01) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_bf_source_file`
    )
    console.warn('[ClickHouse migration] DDL v2 applied')
  }

  // v3 — materialized view backing tables + MVs.
  // Four SummingMergeTree tables for simple counts, one AggregatingMergeTree
  // for reuse_pairs (stores HyperLogLog state for uniq(domain)).
  // MVs only capture INSERTs after creation — backfill is handled below.
  if (lastDdl < 3) {
    // Backing tables
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.domain_counts (
        domain String,
        count  UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY domain
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.password_counts (
        password String,
        count    UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY password
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.url_host_counts (
        url_host String,
        count    UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY url_host
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.reuse_pairs (
        email      String,
        password   String,
        domain_hll AggregateFunction(uniq, String)
      ) ENGINE = AggregatingMergeTree()
      ORDER BY (email, password)
    `)
    // Materialized views (fire-and-forget — CREATE MV is non-blocking)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_domain_counts
      TO ulp.domain_counts AS
      SELECT domain, count() AS count
      FROM ulp.credentials
      WHERE domain != ''
      GROUP BY domain
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_password_counts
      TO ulp.password_counts AS
      SELECT password, count() AS count
      FROM ulp.credentials
      WHERE password != ''
      GROUP BY password
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_url_host_counts
      TO ulp.url_host_counts AS
      SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
      FROM ulp.credentials
      WHERE (url_host != '' OR domain != '')
      GROUP BY url_host
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_reuse_pairs
      TO ulp.reuse_pairs AS
      SELECT
        email,
        password,
        uniqState(domain) AS domain_hll
      FROM ulp.credentials
      WHERE login_type = 'email' AND length(password) > 0
      GROUP BY email, password
    `)
    console.warn('[ClickHouse migration] DDL v3 applied (4 MV tables + 4 MVs)')
  }

  // v4 — ngrambf_v1 skip indexes on url_host + email_domain.
  // These two columns are position()-scanned on every token search query
  // (see lib/ulp-search.ts buildULPWhere, type='token'). Without skip indexes
  // the full 1.46 B row table must be scanned for both conditions per request.
  //
  // ngrambf_v1 builds a bloom filter of all 4-character n-grams per granule.
  // ClickHouse checks the filter before reading granule data: if none of the
  // search term's 4-grams appear in the filter, the granule is skipped entirely.
  //
  // BOTH columns are indexed because the WHERE condition is:
  //   position(url_host, tok) > 0 OR position(email_domain, tok) > 0
  // With OR, ClickHouse can only skip a granule when it can prove BOTH sides
  // are false — indexing only one column leaves the other side unconstrained.
  //
  // Parameters: ngrambf_v1(n=4, size=1024, hash_functions=1, seed=0)
  //   n=4        — 4-char n-grams; shorter terms fall back to full scan (no regression)
  //   size=1024  — 1 KB bloom filter per granule → ~22 MB total at 1.46 B rows
  //   GRANULARITY 1 — one filter per 65,536-row granule (matches all existing indexes)
  //
  // MATERIALIZE INDEX fires a background mutation (mutations_sync=0 default).
  // runMigration fires the second arg non-awaited (.catch()) — exec returns after
  // queueing, build completes in 30–120 min in background.
  // Monitor: SELECT command, is_done, parts_to_do FROM system.mutations
  //          WHERE table = 'credentials' AND command LIKE '%idx_ngram%'
  if (lastDdl < 4) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_url_host
       url_host TYPE ngrambf_v1(4, 1024, 1, 0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_url_host`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_email_domain
       email_domain TYPE ngrambf_v1(4, 1024, 1, 0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_email_domain`
    )
    console.warn('[ClickHouse migration] DDL v4 applied (ngrambf_v1 on url_host + email_domain — MATERIALIZE running in background)')
  }

  // v5 — ⚠️ BROKEN on ClickHouse 26.x.
  // Attempted to replace tokenbf_v1 skip indexes on url/email/password with full_text(0)
  // inverted indexes.  full_text() was renamed to text(tokenizer = ...) in ClickHouse 26.2;
  // the ADD INDEX calls below fail silently on 26.x:
  //   1. ADD INDEX TYPE full_text(0) → "Unknown index type" error → caught by runMigration
  //   2. DROP INDEX old tokenbf_v1 indexes → SUCCEEDS (unrelated to the ADD error)
  //   3. ch_ddl_version bumped to 5
  // Net result on 26.x: old indexes gone, no new indexes added → full 1.46 B row scans
  // on every hasToken() search → 300 s timeout → "credentials search not working".
  //
  // The ADD INDEX calls are kept as a historical record; on ClickHouse ≤25.x they work
  // correctly, but v6 (below) immediately DROPs and re-creates with the 26.x text() API.
  //
  // idx_email_ngram (original ngrambf_v1(3) on email) is also dropped here — no query
  // calls position(email,...) so it never pruned anything.
  if (lastDdl < 5) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_url
       url TYPE full_text(0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_url`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_email
       email TYPE full_text(0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_email`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_password
       password TYPE full_text(0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_password`
    )
    // Drop old tokenbf_v1 indexes and idx_email_ngram (unused).
    // On 26.x the ADD INDEX calls above failed silently, so only these DROPs take effect.
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_password`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email_ngram`)
    console.warn('[ClickHouse migration] DDL v5 applied (old tokenbf_v1 indexes dropped; text() ADD INDEX requires v6 on ClickHouse 26.x)')
  }

  // v6 — Fix for failed v5: ClickHouse 26.2 dropped the full_text() index type in favour of
  // text(tokenizer = splitByNonAlpha, preprocessor = lower(col)).
  //
  // v5 silently failed on ClickHouse 26.x because:
  //   1. ADD INDEX ... TYPE full_text(0) → Unknown type error → caught by runMigration
  //   2. DROP INDEX old tokenbf_v1 indexes → SUCCEEDED (unrelated to the error)
  //   3. ch_ddl_version bumped to 5
  // Result: table has no skip indexes on url/email/password → full 1.46 B row scan on every
  // hasToken() search → 300 s timeout → "credentials search not working".
  //
  // v6 cleans up any partial v5 artifacts and re-creates with the 26.x API:
  //   TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(col))
  //   preprocessor = lower(col) ensures stored tokens are lowercase, matching the
  //   lower(value) the search queries always pass to hasToken().
  //
  // Idempotent: IF EXISTS / IF NOT EXISTS guards make it safe to re-run.
  // DROP IF EXISTS cleans up any partial v5 artifacts; ADD IF NOT EXISTS then re-creates
  // them with the correct 26.x syntax.
  if (lastDdl < 6) {
    // Remove any partial or incorrectly-typed v5 artifacts first
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_inv_password`)
    // Re-create with ClickHouse 26.x text() syntax
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_url
       url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_url`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_email
       email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email)) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_email`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_password
       password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password)) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_password`
    )
    console.warn('[ClickHouse migration] DDL v6 applied (text indexes on url/email/password — MATERIALIZE running in background)')
  }

  // v7 — idempotent re-verification of the v6 text indexes.
  // On ClickHouse 26.x installs where ulp-profiles.xml had both
  //   timeout_overflow_mode = break  AND  use_query_cache = 1
  // every exec() threw error 731 (QUERY_CACHE_USED_WITH_NON_THROW_OVERFLOW_MODE)
  // and all v6 DDL silently failed.  ch_ddl_version was still saved as '6' so
  // migrations were skipped on every subsequent boot, leaving the table with no
  // text skip indexes → full 1.46 B-row scan on every hasToken() search → 300 s
  // timeout → search completely broken.
  //
  // v7 re-runs ADD INDEX IF NOT EXISTS for all three text indexes.  This is a
  // safe no-op if the indexes already exist, and creates them if they are missing.
  // The v6 DROP IF EXISTS is intentionally NOT repeated here to avoid destroying
  // any valid index that was created on a clean install.
  if (lastDdl < 7) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_url
       url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_url`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_email
       email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email)) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_email`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_inv_password
       password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password)) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_inv_password`
    )
    console.warn('[ClickHouse migration] DDL v7 applied (re-verified text indexes — MATERIALIZE running in background)')
  }

  // v8 — re-create MV backing tables + MVs that silently failed in v3 due to error 731.
  //
  // On ClickHouse 26.x installs where ulp-profiles.xml had both
  //   timeout_overflow_mode = break  AND  use_query_cache = 1
  // the ClickHouse settings validator throws error 731
  // (QUERY_CACHE_USED_WITH_NON_THROW_OVERFLOW_MODE) before executing ANY statement —
  // including CREATE TABLE and CREATE MATERIALIZED VIEW.  All v3 DDL silently failed,
  // leaving the MV infrastructure completely missing:
  //
  //   Tables:           ulp.domain_counts, ulp.password_counts,
  //                     ulp.url_host_counts, ulp.reuse_pairs
  //   Materialized views: ulp.mv_domain_counts, ulp.mv_password_counts,
  //                       ulp.mv_url_host_counts, ulp.mv_reuse_pairs
  //
  // Consequence: /stats top-domains / top-passwords / top-url-hosts all fall back
  // to full 52M-row scans; /reuse page throws UNKNOWN_TABLE on every load.
  //
  // IF NOT EXISTS guards make this a no-op when tables already exist.
  // Note: v10 below immediately drops these tables/views again — this block now
  // only matters for installs jumping straight from <v8 to v10 (CREATE then DROP,
  // both idempotent and harmless).
  if (lastDdl < 8) {
    // ── Backing tables ──────────────────────────────────────────────────────
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.domain_counts (
        domain String,
        count  UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY domain
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.password_counts (
        password String,
        count    UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY password
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.url_host_counts (
        url_host String,
        count    UInt64
      ) ENGINE = SummingMergeTree(count)
      ORDER BY url_host
    `)
    await runMigration(`
      CREATE TABLE IF NOT EXISTS ulp.reuse_pairs (
        email      String,
        password   String,
        domain_hll AggregateFunction(uniq, String)
      ) ENGINE = AggregatingMergeTree()
      ORDER BY (email, password)
    `)
    // ── Materialized views ──────────────────────────────────────────────────
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_domain_counts
      TO ulp.domain_counts AS
      SELECT domain, count() AS count
      FROM ulp.credentials
      WHERE domain != ''
      GROUP BY domain
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_password_counts
      TO ulp.password_counts AS
      SELECT password, count() AS count
      FROM ulp.credentials
      WHERE password != ''
      GROUP BY password
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_url_host_counts
      TO ulp.url_host_counts AS
      SELECT if(url_host != '', url_host, domain) AS url_host, count() AS count
      FROM ulp.credentials
      WHERE (url_host != '' OR domain != '')
      GROUP BY url_host
    `)
    await runMigration(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS ulp.mv_reuse_pairs
      TO ulp.reuse_pairs AS
      SELECT
        email,
        password,
        uniqState(domain) AS domain_hll
      FROM ulp.credentials
      WHERE login_type = 'email' AND length(password) > 0
      GROUP BY email, password
    `)
    console.warn('[ClickHouse migration] DDL v8 applied (re-created missing v3 MV tables/views)')
  }

  // v9 — see DDL_VERSION comment above: re-add the v4 ngram skip indexes that never
  // took effect, and drop the legacy indexes v5 intended to remove. All statements
  // are idempotent (ADD/DROP ... IF [NOT] EXISTS).
  if (lastDdl < 9) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_url_host
       url_host TYPE ngrambf_v1(4, 1024, 1, 0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_url_host`
    )
    await runMigration(
      `ALTER TABLE ulp.credentials ADD INDEX IF NOT EXISTS idx_ngram_email_domain
       email_domain TYPE ngrambf_v1(4, 1024, 1, 0) GRANULARITY 1`,
      `ALTER TABLE ulp.credentials MATERIALIZE INDEX idx_ngram_email_domain`
    )
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_url`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_password`)
    await runMigration(`ALTER TABLE ulp.credentials DROP INDEX IF EXISTS idx_email_ngram`)
    console.warn('[ClickHouse migration] DDL v9 applied (added idx_ngram_url_host/idx_ngram_email_domain — MATERIALIZE running in background; dropped redundant legacy indexes)')
  }

  // v10 — Reuse/Similar/Stats pages and APIs removed from the app. Drop the 4 MV
  // backing tables + their materialized views (v3/v8) that were ONLY read by
  // the now-deleted /api/reuse, /api/stats, and /api/admin/rebuild-mv. Views
  // first, then backing tables, to avoid a race where a view tries to write to
  // an already-dropped table.
  if (lastDdl < 10) {
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_domain_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_password_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_url_host_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_reuse_pairs`)
    await runMigration(`DROP TABLE IF EXISTS ulp.domain_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.password_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.url_host_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.reuse_pairs`)
    console.warn('[ClickHouse migration] DDL v10 applied (dropped stats/reuse MV tables + views)')
  }

  // v11 — retry the v10 drops (see DDL_VERSION comment above). Idempotent: all
  // statements use IF EXISTS, so this is a no-op for objects v10 already dropped
  // successfully.
  if (lastDdl < 11) {
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_domain_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_password_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_url_host_counts`)
    await runMigration(`DROP VIEW IF EXISTS ulp.mv_reuse_pairs`)
    await runMigration(`DROP TABLE IF EXISTS ulp.domain_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.password_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.url_host_counts`)
    await runMigration(`DROP TABLE IF EXISTS ulp.reuse_pairs`)
    console.warn('[ClickHouse migration] DDL v11 applied (retried v10 drops after force_restore_data recovery)')
  }

  // v12 — is_noise materialized column for the default-on "Declutter" browse
  // filter. ADD COLUMN is metadata-only/instant; new inserts compute it for free.
  // MATERIALIZE COLUMN backfills existing parts as a background mutation — until it
  // finishes, is_noise is computed on the fly for old parts (i.e. the filter stays
  // slow), so monitor system.mutations and expect the speedup once it completes.
  // is_noise references url_host (itself materialized), mirroring how country_tier
  // references tld. NOISE_EXPR is the single source of truth (lib/ulp-noise.ts).
  if (lastDdl < 12) {
    await runMigration(
      `ALTER TABLE ulp.credentials ADD COLUMN IF NOT EXISTS is_noise UInt8 MATERIALIZED toUInt8(${NOISE_EXPR})`,
      `ALTER TABLE ulp.credentials MATERIALIZE COLUMN is_noise`
    )
    console.warn('[ClickHouse migration] DDL v12 applied (added is_noise column — MATERIALIZE running in background)')
  }

  // v13 — broaden is_noise (see DDL_VERSION comment). MODIFY swaps the MATERIALIZED
  // expression to the expanded NOISE_EXPR; MATERIALIZE COLUMN recomputes in the
  // background (filter stays correct meanwhile — old parts compute is_noise on read).
  if (lastDdl < 13) {
    await runMigration(
      `ALTER TABLE ulp.credentials MODIFY COLUMN is_noise UInt8 MATERIALIZED toUInt8(${NOISE_EXPR})`,
      `ALTER TABLE ulp.credentials MATERIALIZE COLUMN is_noise`
    )
    console.warn('[ClickHouse migration] DDL v13 applied (broadened is_noise — MATERIALIZE running in background)')
  }

  if (lastDdl < DDL_VERSION) {
    setSetting('ch_ddl_version', String(DDL_VERSION))
    console.warn(`[ClickHouse migration] DDL now at v${DDL_VERSION}`)
  } else {
    console.warn(`[ClickHouse migration] DDL v${DDL_VERSION} already applied — skipping`)
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
    console.warn('[ClickHouse migration] data-repair mutations already fired — skipping')
    return
  }
  setSetting('ch_repair_mutations_fired', '1')
  console.warn('[ClickHouse migration] firing data-repair mutations (one-time)')

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
