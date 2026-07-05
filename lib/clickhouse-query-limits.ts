/**
 * Memory ceiling for ad-hoc full-table aggregations (wordlist/hcmask export).
 *
 * The server's effective global memory ceiling is ~14 GiB, not the 16-18 GiB
 * the config comments assume (mark_cache + uncompressed_cache count inside
 * max_server_memory_usage), and it runs a 20-thread background merge pool
 * alongside normal query traffic. No single ad-hoc GROUP BY should be allowed
 * to claim more than a small slice of that — see docs/superpowers/specs for
 * the 2026-06-27 memory-pressure investigation.
 */
export const EXPORT_GROUP_BY_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

/** `SETTINGS max_memory_usage = …, max_execution_time = …` for export GROUP BY queries. */
export function exportGroupBySettings(maxExecutionTime: number): string {
  return `SETTINGS max_memory_usage = ${EXPORT_GROUP_BY_MAX_MEMORY_BYTES}, max_execution_time = ${maxExecutionTime}`
}

/**
 * Memory ceiling for ad-hoc ORDER BY + dedupe (`LIMIT 1 BY`) export sorts.
 *
 * ClickHouse can't push a bounded LIMIT through `ORDER BY ... LIMIT 1 BY <key>
 * ... LIMIT n` — it materializes and fully sorts the entire filtered row set
 * before applying the LIMIT BY, no matter how small the final LIMIT is.
 * Confirmed live against ulp.credentials (91M rows): any sort whose leading
 * column isn't the table's primary-key column (`domain`) hits
 * MEMORY_LIMIT_EXCEEDED once dedupe=1 adds that LIMIT BY. Forcing an external
 * (disk-spill) sort past this threshold converts that crash into a slower
 * (~15-20s) but successful query instead.
 */
export const EXPORT_SORT_MAX_MEMORY_BYTES = 4_294_967_296 // 4 GiB

/** `SETTINGS max_bytes_before_external_sort = …` for export ORDER BY + dedupe queries. */
export function exportSortSettings(): string {
  return `SETTINGS max_bytes_before_external_sort = ${EXPORT_SORT_MAX_MEMORY_BYTES}`
}
