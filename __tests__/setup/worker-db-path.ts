import path from 'path'

/**
 * Deterministic per-worker SQLite DB path. Falls back to a fixed id ('0')
 * if VITEST_POOL_ID isn't available, in which case every worker computes
 * the SAME path — the caller (sqlite-worker-setup.ts) is responsible for
 * making the copy-into-that-path step safe under that degraded case too.
 */
export function getWorkerDbPath(poolId: string | undefined, tmpDir: string): string {
  return path.join(tmpDir, `ulp-suite-vitest-worker-${poolId ?? '0'}.db`)
}
