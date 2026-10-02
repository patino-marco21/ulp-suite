const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

const TRANSIENT_STATUS_CODES = new Set([502, 503, 504])

const TRANSIENT_MESSAGES = [
  'socket hang up',
  'fetch failed',
  'connection closed',
  'econnrefused',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
]

const SEMANTIC_MESSAGES = [
  'bad query',
  'memory limit',
  'syntax error',
  'sql error',
  'parse error',
]

/**
 * Messages that win over the semantic/numeric-code check below, even though they'd
 * otherwise be classified as a deterministic ClickHouse error. Both reflect momentary
 * aggregate server load rather than this query's own inherent cost, so retrying after
 * a brief wait is very plausibly successful — unlike a per-query memory cap or a
 * genuine syntax error, which retrying with the same data will not fix.
 *
 * "(total) memory limit exceeded" specifically means the GLOBAL memory tracker
 * tripped from everything running concurrently, not this one query's own footprint
 * (contrast with a bare/per-query "memory limit (for query) exceeded", which stays
 * semantic via SEMANTIC_MESSAGES above). A stalled socket read/write means the server
 * went quiet for the configured receive/send_timeout, which a server under the same
 * transient load can do without the query itself being hung.
 */
const TRANSIENT_OVERLOAD_MESSAGES = [
  '(total) memory limit exceeded',
  'timeout exceeded while reading from socket',
  'timeout exceeded while writing to socket',
]

/**
 * Server-side errors that carry a numeric ClickHouse code (so the semantic rule below would call them final) but clear on
 * their own within seconds. Checked before that rule.
 *
 *   242  TABLE_IS_READ_ONLY   a replica loses its Keeper session for about 0.1 s after a laptop suspend/resume
 *   252  TOO_MANY_PARTS       insert pressure; background merges catch up
 *   209  SOCKET_TIMEOUT, 210 NETWORK_ERROR   the server could not reach a peer or the client
 *   999  KEEPER_EXCEPTION     only the session/connection flavours; "No node", "Node exists" and the like stay final
 */
const TRANSIENT_SERVER_CODES = new Set(['242', '252', '209', '210'])
const TRANSIENT_SERVER_PHRASES = ['table is in readonly mode', 'table is in read-only mode', 'too many parts']
const TRANSIENT_KEEPER_PHRASES = ['session expired', 'connection loss', 'operation timeout']

const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_ELAPSED_MS = 30 * 60 * 1_000

export interface ClickHouseRetryOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  maxElapsedMs?: number
  sleep?: (delayMs: number) => Promise<void>
  now?: () => number
  onRetry?: (event: { attempt: number; delayMs: number; error: unknown }) => void
  /**
   * Ends the loop at once when it fires: the attempt in flight is aborted, no further attempt starts, and the promise
   * rejects with `signal.reason`. An abort is never retried.
   */
  signal?: AbortSignal
}

export class ClickHouseRetryExhaustedError extends Error {
  attempts: number
  lastError: unknown

  constructor(attempts: number, lastError: unknown) {
    super(
      `ClickHouse retry deadline exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}; ` +
      `last error: ${privacySafeClickHouseErrorSummary(lastError)}`
    )
    this.name = 'ClickHouseRetryExhaustedError'
    this.attempts = attempts
    this.lastError = lastError
  }
}

export function privacySafeClickHouseErrorSummary(error: unknown): string {
  const code = getCode(error) ?? getCode(
    error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined
  )
  if (TRANSIENT_CODES.has(String(code))) return String(code)

  const status = getStatus(error)
  if (TRANSIENT_STATUS_CODES.has(Number(status))) return `HTTP ${Number(status)}`

  const message = getMessage(error).toLowerCase()
  if (message === 'timeout error.') return 'Timeout error.'
  for (const phrase of TRANSIENT_MESSAGES) {
    if (message.includes(phrase)) return phrase
  }

  return 'transient ClickHouse error'
}

function getCode(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  return (value as { code?: unknown }).code
}

function getStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  return (value as { status?: unknown; statusCode?: unknown }).status ?? (value as { status?: unknown; statusCode?: unknown }).statusCode
}

function getMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (!value || typeof value !== 'object') {
    return String(value)
  }

  const message = (value as { message?: unknown }).message
  return typeof message === 'string' ? message : String(value)
}

function hasSemanticClickHouseSignal(error: unknown): boolean {
  const message = getMessage(error).toLowerCase()

  const code = getCode(error)

  if ((typeof code === 'number' && Number.isFinite(code)) ||
      (typeof code === 'string' && /^\d+$/.test(code))) {
    return true
  }

  return SEMANTIC_MESSAGES.some(fragment => message.includes(fragment))
}

function hasSemanticClickHouseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  if (hasSemanticClickHouseSignal(error)) {
    return true
  }

  return hasSemanticClickHouseSignal((error as { cause?: unknown }).cause)
}

function hasTransientOverloadMessage(error: unknown): boolean {
  const message = getMessage(error).toLowerCase()
  return TRANSIENT_OVERLOAD_MESSAGES.some(phrase => message.includes(phrase))
}

function hasTransientServerSignal(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const code = String(getCode(error) ?? '')
  const message = getMessage(error).toLowerCase()

  if (TRANSIENT_SERVER_CODES.has(code)) return true
  if (TRANSIENT_SERVER_PHRASES.some(phrase => message.includes(phrase))) return true
  return code === '999' && TRANSIENT_KEEPER_PHRASES.some(phrase => message.includes(phrase))
}

export function isTransientClickHouseError(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'string')) {
    return false
  }

  if (
    hasTransientOverloadMessage(error) ||
    hasTransientOverloadMessage((error as { cause?: unknown }).cause)
  ) {
    return true
  }

  if (
    hasTransientServerSignal(error) ||
    hasTransientServerSignal((error as { cause?: unknown }).cause)
  ) {
    return true
  }

  if (hasSemanticClickHouseError(error)) {
    return false
  }

  const code = getCode(error)
  const causeCode = getCode((error as { cause?: unknown }).cause)
  const status = getStatus(error)
  const message = getMessage(error).toLowerCase()

  if (message === 'timeout error.') {
    return true
  }

  if (TRANSIENT_CODES.has(String(code))) {
    return true
  }

  if (TRANSIENT_CODES.has(String(causeCode))) {
    return true
  }

  if (TRANSIENT_STATUS_CODES.has(Number(status))) {
    return true
  }

  if (TRANSIENT_MESSAGES.some(fragment => message.includes(fragment))) {
    return true
  }

  return false
}

function delayForAttempt(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempt - 1)
  const nextDelay = initialDelayMs * (2 ** exponent)
  return Math.min(maxDelayMs, nextDelay)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export async function withClickHouseRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ClickHouseRetryOptions = {}
): Promise<T> {
  const {
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    maxElapsedMs = DEFAULT_MAX_ELAPSED_MS,
    sleep = (delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)),
    now = () => Date.now(),
    onRetry,
    signal,
  } = options

  const startedAt = now()
  let attempts = 0
  let lastError: unknown
  let activeController: AbortController | undefined
  let rejectDeadline!: (error: ClickHouseRetryExhaustedError) => void
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const deadlineTimer = setTimeout(() => {
    const deadlineCause = lastError ?? new Error('Timeout error.')
    rejectDeadline(new ClickHouseRetryExhaustedError(attempts, deadlineCause))
    activeController?.abort(deadlineCause)
  }, Math.max(0, maxElapsedMs))

  // An external abort (the import was cancelled or stalled) ends the loop at once; it is never retried.
  let rejectAbort!: (reason: unknown) => void
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  abortPromise.catch(() => {}) // the loop may finish first: that must not become an unhandled rejection
  const onAbort = () => {
    if (!signal) return
    rejectAbort(abortReason(signal))
    activeController?.abort(signal.reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal?.aborted) throw abortReason(signal)

    while (true) {
      attempts += 1
      activeController = new AbortController()

      try {
        const result = await Promise.race([
          operation(activeController.signal),
          deadlinePromise,
          abortPromise,
        ])
        activeController = undefined
        return result
      } catch (error) {
        activeController = undefined
        if (error instanceof ClickHouseRetryExhaustedError) throw error
        if (signal?.aborted) throw abortReason(signal)
        lastError = error

        if (!isTransientClickHouseError(error)) {
          throw error
        }

        const delayMs = delayForAttempt(attempts, initialDelayMs, maxDelayMs)
        const deadline = startedAt + maxElapsedMs

        if (now() + delayMs > deadline) {
          throw new ClickHouseRetryExhaustedError(attempts, error)
        }

        onRetry?.({ attempt: attempts, delayMs, error })
        await Promise.race([sleep(delayMs), deadlinePromise, abortPromise])
      }
    }
  } finally {
    clearTimeout(deadlineTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}
