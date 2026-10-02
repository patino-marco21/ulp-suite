/**
 * One wrapper for every import job: an HTTP upload, a v1 API upload and an inbox file all run through `runImportJob`.
 *
 * It gives the job an AbortSignal and a heartbeat, and fails the job (and frees its queue slot) when the heartbeat stops.
 * The slot is released when the work settles OR when the signal aborts, whichever comes first: before this existed, one
 * wedged pipeline held a slot of the shared `uploadQueue` until the app restarted, which also stopped the inbox.
 *
 * Idle time is measured with performance.now(), never Date.now(). This laptop suspends; the monotonic clock does not
 * advance while it sleeps, so a wall-clock watchdog would fail a healthy job the moment the lid reopens.
 */
import { performance } from 'node:perf_hooks'

const DEFAULT_STALL_MS = 20 * 60_000

/** Reads IMPORT_STALL_TIMEOUT_MS. An unset, empty, non-numeric or non-positive value falls back to 20 minutes. */
export function parseStallMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MS
}

export class ImportStalledError extends Error {
  readonly label: string
  readonly idleMs: number

  constructor(label: string, idleMs: number) {
    super(`import of ${label} stalled: no progress for ${Math.round(idleMs / 1000)} s`)
    this.name = 'ImportStalledError'
    this.label = label
    this.idleMs = idleMs
  }
}

export interface ImportContext {
  /** Aborted when the job is cancelled or stalls. Pass it to every awaited operation that accepts one. */
  signal: AbortSignal
  /** Call whenever the job makes progress: a batch inserted, a retry attempted, a memory-guard poll. */
  beat: () => void
}

/** What the pipeline functions accept: both parts optional, so existing callers and tests need no change. */
export type ImportHooks = Partial<ImportContext>

export interface RunImportOptions<T> {
  label: string
  work: (ctx: ImportContext) => Promise<T>
  /** An external cancel (a future Cancel button). */
  signal?: AbortSignal
  stallMs?: number
  /** Monotonic clock in ms; tests replace it. */
  now?: () => number
}

export async function runImportJob<T>(opts: RunImportOptions<T>): Promise<T> {
  // Already cancelled: do not even start the work.
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('import aborted')

  const stallMs = opts.stallMs ?? parseStallMs(process.env.IMPORT_STALL_TIMEOUT_MS)
  const now = opts.now ?? (() => performance.now())

  const controller = new AbortController()
  const onExternalAbort = () => controller.abort(opts.signal?.reason)
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true })

  let lastBeat = now()
  const beat = () => { lastBeat = now() }

  // Check often enough that a stall is reported within a quarter of the window, but never more than every 30 s.
  const watchdog = setInterval(() => {
    if (controller.signal.aborted) return
    const idleMs = now() - lastBeat
    if (idleMs > stallMs) {
      console.warn(`[import-runner] ${opts.label}: no progress for ${Math.round(idleMs / 1000)} s; failing the job and releasing its queue slot`)
      controller.abort(new ImportStalledError(opts.label, idleMs))
    }
  }, Math.min(30_000, Math.max(10, Math.floor(stallMs / 4))))
  watchdog.unref?.()

  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(controller.signal.reason ?? new Error('import aborted'))
    if (controller.signal.aborted) fail()
    else controller.signal.addEventListener('abort', fail, { once: true })
  })
  aborted.catch(() => {}) // the work may win the race: that must not become an unhandled rejection

  let work: Promise<T> | undefined
  try {
    work = opts.work({ signal: controller.signal, beat })
    return await Promise.race([work, aborted])
  } finally {
    clearInterval(watchdog)
    opts.signal?.removeEventListener('abort', onExternalAbort)
    // If we left because of an abort, the work may still settle later; its rejection is already accounted for.
    work?.catch(() => {})
  }
}
