/**
 * Several reducer processes on one archive (scripts/reduce-archive.ts run --workers N). The command's one lock (reduced/.lock) stays with the coordinator that started them; what
 * a worker needs besides is to know which file another worker has taken. It takes a file by creating `reduced/claims/<key>` (`wx`: only one creator wins) with its pid in it; a claim
 * whose process is gone is taken over; a worker removes only its own. The coordinator clears the directory when it starts, under the lock, when no worker can be alive.
 */
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const claimsDir = (archiveDir: string): string => join(archiveDir, 'reduced', 'claims')

/** A file name of its own for a (name, bytes) pair: nothing of the data file's name reaches a path. */
export function claimKey(name: string, sha256: string): string {
  return createHash('sha1').update(`${name}\0${sha256}`).digest('hex')
}

export function isAlive(pid: number): boolean {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'   // the process exists but is not ours to signal
  }
}

export interface ClaimOptions {
  pid?: number
  alive?: (pid: number) => boolean
}

/** True when the caller now holds the claim. */
export function tryClaim(dir: string, key: string, opts: ClaimOptions = {}): boolean {
  const pid = opts.pid ?? process.pid
  const alive = opts.alive ?? isAlive
  mkdirSync(dir, { recursive: true })
  const path = join(dir, key)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(pid))
      closeSync(fd)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let holder = 0
      try { holder = Number(readFileSync(path, 'utf8')) } catch { /* gone meanwhile */ }
      if (holder > 0 && alive(holder)) return false
      rmSync(path, { force: true })   // its process is gone (or it was cut short before the pid was written): take it over
    }
  }
  return false
}

/** Removes the claim if it is the caller's own. */
export function releaseClaim(dir: string, key: string, pid: number = process.pid): void {
  const path = join(dir, key)
  try {
    if (Number(readFileSync(path, 'utf8')) === pid) rmSync(path, { force: true })
  } catch {
    /* not there */
  }
}

export function clearClaims(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** The arguments a worker is started with: those of the command, without `--workers N`. */
export function workerArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workers') { i++; continue }
    out.push(argv[i])
  }
  return out
}
