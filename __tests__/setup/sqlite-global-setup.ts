import fs from 'fs'
import os from 'os'
import path from 'path'

export const TEMPLATE_DB_PATH = path.join(os.tmpdir(), 'ulp-suite-vitest-template.db')

export default async function setup() {
  // Must be set before lib/sqlite.ts is imported — it reads SQLITE_PATH
  // once, at module-evaluation time, into a top-level const.
  process.env.SQLITE_PATH = TEMPLATE_DB_PATH

  // Fresh template every run — don't accumulate state across separate
  // `npx vitest run` invocations.
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEMPLATE_DB_PATH + suffix, { force: true })
  }

  const { ensureDb, dbExec } = await import('../../lib/sqlite')
  ensureDb() // runs the full, already race-safe initSchema + seedDefaultAdmin

  // Merge WAL into the main file and empty it, so a plain single-file copy
  // in sqlite-worker-setup.ts captures complete state without also needing
  // to copy -wal/-shm sidecars for the template itself.
  dbExec('PRAGMA wal_checkpoint(TRUNCATE)')

  return async function teardown() {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(TEMPLATE_DB_PATH + suffix, { force: true })
    }
    // Clean up every per-worker copy Task 3 may have created, in case an
    // individual worker's own cleanup (if any) didn't run — e.g. a worker
    // that crashed mid-run.
    const tmpDir = os.tmpdir()
    for (const name of fs.readdirSync(tmpDir)) {
      if (name.startsWith('ulp-suite-vitest-worker-')) {
        fs.rmSync(path.join(tmpDir, name), { force: true })
      }
    }
  }
}
