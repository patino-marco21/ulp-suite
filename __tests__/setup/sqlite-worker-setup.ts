import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { getWorkerDbPath } from './worker-db-path'
import { TEMPLATE_DB_PATH } from './sqlite-global-setup'

const workerDbPath = getWorkerDbPath(process.env.VITEST_POOL_ID, os.tmpdir())

if (!fs.existsSync(workerDbPath)) {
  // Copy to a uniquely-named temp file, then rename into place. rename() is
  // atomic on POSIX within the same filesystem, so even if two workers race
  // here (e.g. VITEST_POOL_ID unavailable and both compute the same path),
  // the loser's rename just overwrites with an equally-valid fresh copy of
  // the same template — never a half-written file.
  const scratch = `${workerDbPath}.tmp-${crypto.randomBytes(4).toString('hex')}`
  try {
    fs.copyFileSync(TEMPLATE_DB_PATH, scratch)
    fs.renameSync(scratch, workerDbPath)
  } catch (err) {
    fs.rmSync(scratch, { force: true })
    throw err
  }
}

// Idempotent to repeat across multiple test files in the same worker —
// intentionally does NOT re-copy if workerDbPath already exists, so state
// written by earlier test files in this worker persists for later ones,
// matching today's existing single-shared-path workaround's behavior.
process.env.SQLITE_PATH = workerDbPath
