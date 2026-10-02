/**
 * Upload spool.
 *
 * The HTTP upload routes used to answer BEFORE they had the file and let the request body trickle into the importer at the
 * importer's pace. Four ways that went wrong were reproduced on 2026-10-02 (a 5 s consumer stall, an upload queued behind a
 * busy slot, the 300 s request timeout, a client disconnect): each left a job that never finished and held its slot of the
 * shared queue, which also stopped the inbox. The ZIP branch and the inbox, which read from a file, were immune. This module
 * gives the text routes the same property: receive the whole body into a file first, then import from the file.
 * See docs/superpowers/specs/2026-10-02-import-reliability-design.md.
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { capWebStream, MaxBytesExceededError } from '@/lib/size-capped-stream'
import { formatBytes } from '@/lib/utils'

const GIB = 1024 ** 3
const HOUR_MS = 60 * 60_000

export function spoolDir(): string {
  return process.env.UPLOAD_SPOOL_DIR?.trim() || '/tmp/ulp-spool'
}

/** The upload is refused when it would leave less than this free. The disk is shared with ClickHouse. */
export function spoolMinFreeBytes(): number {
  const raw = process.env.UPLOAD_SPOOL_MIN_FREE_BYTES
  if (raw === undefined || raw.trim() === '') return 20 * GIB
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 20 * GIB
}

export class SpoolIncompleteError extends Error {
  readonly received: number
  readonly expected: number

  constructor(received: number, expected: number) {
    super(`upload incomplete: received ${received} of ${expected} bytes`)
    this.name = 'SpoolIncompleteError'
    this.received = received
    this.expected = expected
  }
}

export class SpoolInsufficientStorageError extends Error {
  readonly freeBytes: number
  readonly neededBytes: number

  constructor(freeBytes: number, neededBytes: number) {
    super(`not enough free disk space for this upload (free ${freeBytes} bytes, need ${neededBytes} including the reserve)`)
    this.name = 'SpoolInsufficientStorageError'
    this.freeBytes = freeBytes
    this.neededBytes = neededBytes
  }
}

// globalThis-backed: the routes and instrumentation.ts are compiled into separate webpack chunks (see lib/upload-queue.ts).
declare global {
  // eslint-disable-next-line no-var
  var __ulpSpoolOwned: Set<string> | undefined
  // eslint-disable-next-line no-var
  var __ulpSpoolJanitorStop: (() => void) | undefined
}

/** Spool files a job in this process owns; the janitor never touches them. */
const owned = globalThis.__ulpSpoolOwned ?? (globalThis.__ulpSpoolOwned = new Set<string>())

export interface SpoolOptions {
  /** Hard cap on the bytes accepted (the admin-configured max file size). */
  maxBytes: number
  /** Aborts the receive (Next aborts `request.signal` when the client disconnects before the response finishes). */
  signal?: AbortSignal
  /** The client's Content-Length, when it sent one: the body must be exactly this long. */
  expectedBytes?: number
  /** Tests only. */
  dir?: string
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>
  minFreeBytes?: number
}

export interface SpoolResult {
  path: string
  bytes: number
}

async function freeBytesOf(dir: string, statfs: SpoolOptions['statfs']): Promise<number> {
  const st = await (statfs ?? fs.promises.statfs)(dir)
  return Number(st.bavail) * Number(st.bsize)
}

/**
 * Receive `body` into a new file in the spool directory.
 *
 * The file is written as `<uuid>.part` and renamed to `<uuid>.upload` only when the body ended normally and matches the
 * declared length, so a cut upload can never be mistaken for a whole one. Any failure, abort or short body deletes the file.
 * Resolves with the path of the finished file, which the caller owns until `discardSpool`.
 */
export async function spoolRequestBody(body: ReadableStream<Uint8Array>, opts: SpoolOptions): Promise<SpoolResult> {
  const dir = opts.dir ?? spoolDir()
  const minFree = opts.minFreeBytes ?? spoolMinFreeBytes()
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })

  const free = await freeBytesOf(dir, opts.statfs)
  const declared = opts.expectedBytes ?? 0
  if (free - declared < minFree) throw new SpoolInsufficientStorageError(free, declared + minFree)
  // A body with no declared length (chunked) can only be held to the same floor while it streams.
  const budget = Math.max(0, free - minFree)

  const base = path.join(dir, randomUUID())
  const partPath = `${base}.part`
  const finalPath = `${base}.upload`
  let bytes = 0

  const counted = capWebStream(body, opts.maxBytes).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > budget) {
          controller.error(new SpoolInsufficientStorageError(free, bytes + minFree))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )

  try {
    await pipeline(
      Readable.fromWeb(counted as import('stream/web').ReadableStream<Uint8Array>),
      fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 }),
      { signal: opts.signal },
    )
    if (opts.expectedBytes !== undefined && bytes !== opts.expectedBytes) {
      throw new SpoolIncompleteError(bytes, opts.expectedBytes)
    }
    await fs.promises.rename(partPath, finalPath)
  } catch (err) {
    await fs.promises.rm(partPath, { force: true }).catch(() => {})
    if (opts.signal?.aborted) throw opts.signal.reason ?? err
    throw err
  }

  owned.add(finalPath)
  return { path: finalPath, bytes }
}

/** Delete a spool file and stop protecting it from the janitor. Safe to call twice. */
export async function discardSpool(filePath: string): Promise<void> {
  owned.delete(filePath)
  await fs.promises.rm(filePath, { force: true }).catch(() => {})
}

/**
 * Delete spool files that no running job in this process owns and that are at least `maxAgeMs` old. Returns their names.
 * At startup call it with 0: a new process owns nothing, so everything left in the directory is an orphan of the last run.
 * An in-flight `.part` is never older than the 5 minutes Node allows a request to take, so an hourly sweep cannot hit one.
 */
export async function sweepSpool(opts: { dir?: string; maxAgeMs: number; now?: () => number }): Promise<string[]> {
  const dir = opts.dir ?? spoolDir()
  const now = (opts.now ?? Date.now)()
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    if (owned.has(full)) continue
    try {
      const { mtimeMs } = await fs.promises.stat(full)
      // Clamp: a file written in this very millisecond has an mtime a fraction ahead of Date.now(), i.e. a negative age.
      if (Math.max(0, now - mtimeMs) >= opts.maxAgeMs) {
        await fs.promises.rm(full, { force: true })
        removed.push(entry.name)
      }
    } catch {
      /* already gone */
    }
  }
  return removed
}

/**
 * Clean the spool at startup, then hourly. Called from instrumentation.ts (production only). Returns a stop function;
 * a second call while one is running returns the same stop and does nothing else.
 */
export function startSpoolJanitor(): () => void {
  if (globalThis.__ulpSpoolJanitorStop) return globalThis.__ulpSpoolJanitorStop

  sweepSpool({ maxAgeMs: 0 })
    .then(removed => {
      if (removed.length > 0) console.warn(`[upload-spool] removed ${removed.length} leftover spool file(s) from a previous run`)
    })
    .catch(err => console.error('[upload-spool] startup sweep failed:', err))

  const timer = setInterval(() => {
    sweepSpool({ maxAgeMs: HOUR_MS }).catch(err => console.error('[upload-spool] hourly sweep failed:', err))
  }, HOUR_MS)
  timer.unref?.()

  const stop = () => {
    clearInterval(timer)
    globalThis.__ulpSpoolJanitorStop = undefined
  }
  globalThis.__ulpSpoolJanitorStop = stop
  return stop
}

/** The HTTP status and message for a spool failure, or null when the error is something else. */
export function describeSpoolError(error: unknown): { status: number; message: string } | null {
  if (error instanceof MaxBytesExceededError) {
    return { status: 413, message: `File too large (max ${formatBytes(error.limitBytes)})` }
  }
  if (error instanceof SpoolIncompleteError) {
    return { status: 400, message: `Upload incomplete: ${error.received} of ${error.expected} bytes arrived. Nothing was imported.` }
  }
  if (error instanceof SpoolInsufficientStorageError) {
    return { status: 507, message: 'Not enough free disk space to accept this upload.' }
  }
  return null
}
