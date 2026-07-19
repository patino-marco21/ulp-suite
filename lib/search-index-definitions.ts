/**
 * Single source of truth for the ClickHouse skip indexes credential search
 * depends on. Two independent callers need the exact same DDL:
 *  - lib/clickhouse-migrations.ts (DDL v17): applies these to the live,
 *    already-populated ulp.credentials table, with MATERIALIZE INDEX to
 *    backfill existing parts.
 *  - lib/content-dedup.ts: applies these to a freshly-created, still-empty
 *    rewrite+swap clone table BEFORE it's populated, so the indexes are
 *    built for free as rows are written (no MATERIALIZE needed) -- and so a
 *    future swap can never silently carry forward a search-index gap.
 * Keeping one definition list (rather than two copies of the same DDL)
 * means the two callers can't drift out of sync as indexes change over time.
 *
 * See docs/superpowers/specs/2026-07-19-credentials-search-domain-fix-design.md
 * for why each index exists and how its parameters were chosen.
 */

export interface SearchIndexDefinition {
  /** Index name, matching the name used in the CREATE/ALTER TABLE statement. */
  name: string
  /**
   * DROP INDEX IF EXISTS -- always run before addIndexSql. Harmless no-op on
   * a table where the index doesn't exist yet (a fresh swap clone); required
   * on one where it exists with stale parameters (ADD INDEX IF NOT EXISTS
   * alone would no-op on a name match, even if the TYPE(...) params differ).
   */
  dropIndexSql: (table: string) => string
  /** ADD INDEX IF NOT EXISTS with the current, correct definition. */
  addIndexSql: (table: string) => string
}

export const SEARCH_INDEX_DEFINITIONS: SearchIndexDefinition[] = [
  {
    name: 'idx_inv_url',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_inv_url`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_inv_url
      url TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(url)) GRANULARITY 1`,
  },
  {
    name: 'idx_inv_email',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_inv_email`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_inv_email
      email TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(email)) GRANULARITY 1`,
  },
  {
    name: 'idx_inv_password',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_inv_password`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_inv_password
      password TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(password)) GRANULARITY 1`,
  },
  {
    name: 'idx_ngram_url_host',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_ngram_url_host`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_ngram_url_host
      url_host TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1`,
  },
  {
    name: 'idx_ngram_email_domain',
    dropIndexSql: table => `ALTER TABLE ${table} DROP INDEX IF EXISTS idx_ngram_email_domain`,
    addIndexSql: table => `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_ngram_email_domain
      email_domain TYPE ngrambf_v1(4, 8192, 4, 0) GRANULARITY 1`,
  },
]
