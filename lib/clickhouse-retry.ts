const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
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
  'too many parts',
]

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

export function isTransientClickHouseError(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'string')) {
    return false
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

  try {
    while (true) {
      attempts += 1
      activeController = new AbortController()

      try {
        const result = await Promise.race([
          operation(activeController.signal),
          deadlinePromise,
        ])
        activeController = undefined
        return result
      } catch (error) {
        activeController = undefined
        if (error instanceof ClickHouseRetryExhaustedError) throw error
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
        await Promise.race([sleep(delayMs), deadlinePromise])
      }
    }
  } finally {
    clearTimeout(deadlineTimer)
  }
}
