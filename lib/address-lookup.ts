/**
 * Case-insensitive exact-address lookup: docs/superpowers/specs/2026-10-13-case-insensitive-address-lookup-design.md.
 *
 * Logins are stored as typed, so `email = lower(value)` cannot see an address stored with a capital. A bloom filter on the EXPRESSION
 * `lower(email)` (idx_bf_email_lc) lets `lower(email) = lower(value)` prune as well as the exact match did. ClickHouse uses a skip index
 * only when the query contains the identical expression, so the expression and the index name live here once: DDL v29, the
 * SEARCH_INDEX_DEFINITIONS list, scripts/materialize-address-index.sh and every query that looks an address up are built from this file.
 *
 * `lower` folds ASCII letters only and leaves every other character alone. It is applied to both sides, so "equal" means "equal ignoring
 * ASCII case", which is exactly what the index stores. Pure strings and no imports: scripts load this file through tsx.
 */

/** The name of the index. */
export const ADDRESS_INDEX_NAME = 'idx_bf_email_lc'

/** The indexed expression, exactly as every query must write it. */
export const ADDRESS_INDEX_EXPR = 'lower(email)'

/** The same type and false-positive rate as idx_bf_email. */
export const ADDRESS_INDEX_TYPE = 'bloom_filter(0.05)'

/**
 * Every query that compares lower(email) carries this setting. Given a projection to choose from, the planner can read the whole projection
 * (it counts marks and does not credit the skip index's pruning) and then never uses idx_bf_email_lc. Measured on a 46M-row copy of the table in
 * which every part carried proj_imported_desc: an absent address took 0.42 s that way and 0.021 s with the setting. On the live table today the
 * projection exists only on the newest partition and the two are indistinguishable (0.79 s both, 2026-10-13), so the setting is insurance for the
 * day the projection is restored on more partitions and for query shapes that were not measured. It costs nothing.
 */
export const ADDRESS_LOOKUP_SETTING = 'optimize_use_projections = 0'

/** `lower(email) = lower({param:String})`: the login equals the value, ignoring ASCII case. */
export function addressEquals(param: string): string {
  return `${ADDRESS_INDEX_EXPR} = lower({${param}:String})`
}

/** `lower(email) != lower({param:String})`: any other login. */
export function addressDiffers(param: string): string {
  return `${ADDRESS_INDEX_EXPR} != lower({${param}:String})`
}

/** `lower(email) IN (lower({a:String}), lower({b:String}), ...)` for a list of parameter names. */
export function addressIn(params: string[]): string {
  return `${ADDRESS_INDEX_EXPR} IN (${params.map(p => `lower({${p}:String})`).join(', ')})`
}

/** ADD INDEX IF NOT EXISTS: safe to run again. Metadata only; parts written before it need MATERIALIZE INDEX (scripts/materialize-address-index.sh). */
export function addressIndexAddSql(table: string): string {
  return `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS ${ADDRESS_INDEX_NAME} ${ADDRESS_INDEX_EXPR} TYPE ${ADDRESS_INDEX_TYPE} GRANULARITY 1`
}

/** DROP INDEX IF EXISTS: the pair of the above in SEARCH_INDEX_DEFINITIONS. */
export function addressIndexDropSql(table: string): string {
  return `ALTER TABLE ${table} DROP INDEX IF EXISTS ${ADDRESS_INDEX_NAME}`
}
