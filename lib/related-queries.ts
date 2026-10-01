/**
 * SQL for /api/related's three buckets (app/api/related/route.ts), kept here so the
 * route, its tests and any live check run the exact same text.
 *
 * Each bucket is an inner query that filters, sorts and limits on RAW columns, wrapped by
 * an outer query that applies NORM_COLS to the (at most RELATED_LIMIT) rows that survive --
 * the same split app/api/credentials/route.ts and app/api/export/route.ts use.
 *
 * WHY THE SPLIT: NORM_COLS aliases url, email, password and domain. In a single-level
 * `SELECT ${NORM_COLS} ... WHERE email = {email:String}` those aliases shadow the stored
 * columns inside WHERE, so the filter is evaluated on the normalized expression instead of
 * the column and neither the primary key (domain, email, imported_at) nor the bloom-filter
 * skip indexes can prune. The planner then scans proj_imported_desc newest-first looking for
 * 25 matches. Measured live 2026-09-30 on 1.39B rows: all 78 queries the panel sent in three
 * hours ran into max_execution_time = 30 and returned 0 rows (`timeout_overflow_mode =
 * 'break'` hands back whatever was read by the deadline, here nothing, so the panel just looked
 * empty). The cap now THROWS, so a bucket that cannot finish is reported as failed (see the
 * route) instead of as "none found". The inner query must stay free of NORM_COLS and of any
 * alias that reuses a column name, or that pruning is lost again.
 *
 * `prefer_column_name_to_alias = 1` would also make the single-level form fast, but the split is
 * what keeps the filter on the stored columns regardless of settings. The outer query DOES carry that
 * setting (NORM_COLS_SETTING, see lib/ulp-normalize.ts): without it NORM_COLS's own aliases shadow the
 * columns it reads and the legacy-row corrections come out half-applied. Every route that selects
 * NORM_COLS carries it, so this panel and the Credentials table agree.
 *
 * WHY ORDER BY domain, email (not imported_at): the split alone fixes rare values (0.9-1.5 s,
 * the bloom filters prune) but not popular ones. Sorting the filtered rows by imported_at is
 * not an order the table can give for free, so a login or password that matches in nearly
 * every granule (the bloom filter prunes nothing) reads the whole table and sorts it:
 * measured cold, `email = 'admin'` 9.5 s / 963M rows, `password = '123456'` 21.9 s / 1.39B
 * rows, against the 30 s cap. The primary-key prefix IS free -- ClickHouse reads in key order
 * and stops after 25 rows -- and all nine probes (rare and popular logins, domains and
 * passwords) then ran in 0.9-1.5 s. Same choice, same reasoning as MATCH_ORDER_BY in
 * lib/monitor-match-resolver.ts. The cost: when more than RELATED_LIMIT rows match, the panel
 * shows the first 25 by (domain, email) rather than the 25 newest; they still display newest
 * first (the outer ORDER BY), and a bucket with <= 25 matches is returned complete either way.
 *
 * Params: {email:String}, {domain:String}, {password:String} -- see the route for which
 * bucket binds which.
 */
import { NORM_COLS, NORM_COLS_SETTING } from '@/lib/ulp-normalize'

/** Rows per bucket. */
export const RELATED_LIMIT = 25

/** Stored columns the inner query reads: raw, so the WHERE below can prune. */
const RAW_COLS = `url, email, password, domain, breach_name, country_tier, login_type, imported_at`

/** Outer SELECT: normalized url/email/password/domain plus the same extras, in the same order as before. */
const OUTER_COLS = `${NORM_COLS}, breach_name, country_tier, login_type, imported_at`

/** The primary-key prefix -- the one sort the table gives away for free (see the file comment). */
const SAMPLE_ORDER_BY = 'domain, email'

function relatedQuery(where: string): string {
  // The outer ORDER BY re-sorts <= RELATED_LIMIT rows for display; it also spares the display
  // order from depending on how ClickHouse streams a subquery's rows into the outer SELECT.
  return `SELECT ${OUTER_COLS}
     FROM (
       SELECT ${RAW_COLS}
       FROM ulp.credentials
       WHERE ${where}
       ORDER BY ${SAMPLE_ORDER_BY}
       LIMIT ${RELATED_LIMIT}
     ) AS t
     ORDER BY imported_at DESC
     SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, use_query_cache = 0, ${NORM_COLS_SETTING}`
}

/** Same login on other rows -- cross-domain reuse of one account. */
export const RELATED_BY_EMAIL_SQL = relatedQuery('email = {email:String}')

/** Other logins on the same domain -- exposure breadth. */
export const RELATED_BY_DOMAIN_SQL = relatedQuery('domain = {domain:String} AND email != {email:String}')

/** Other accounts using the exact same password. */
export const RELATED_BY_PASSWORD_SQL = relatedQuery('password = {password:String} AND email != {email:String}')
