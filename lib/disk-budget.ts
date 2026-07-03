/**
 * Live-table disk-budget check for the credentials store, surfaced on the Ingest
 * Health panel so the ~550GB ceiling (docs/superpowers/specs/2026-07-03-scale-
 * tiered-archive-design.md) is a visible, monitored number rather than something
 * discovered via a failed insert. Counts both the base table and the
 * proj_imported_desc projection -- the projection is a real, separate cost
 * (system.projection_parts), not included in system.parts.
 */

/** Live-table budget in bytes. Default 550GB (~70% of this laptop's 784GB disk). */
export function diskBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const b = parseInt(env.DISK_BUDGET_BYTES ?? '', 10)
  return Number.isFinite(b) && b > 0 ? b : 550 * 1024 ** 3
}

export function buildLiveBytesSql(): string {
  return `SELECT
    (SELECT sum(data_compressed_bytes) FROM system.parts WHERE database = 'ulp' AND active) +
    (SELECT sum(data_compressed_bytes) FROM system.projection_parts WHERE database = 'ulp' AND active) AS bytes`
}

/** Percentage of budget used, rounded. 0 if budget is 0 (avoids divide-by-zero). */
export function diskBudgetPct(usedBytes: number, budgetBytes: number): number {
  return budgetBytes > 0 ? Math.round((usedBytes / budgetBytes) * 100) : 0
}
