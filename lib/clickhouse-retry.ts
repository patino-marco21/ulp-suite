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
    super(`ClickHouse retry deadline exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}`)
    this.name = 'ClickHouseRetryExhaustedError'
    this.attempts = attempts
    this.lastError = lastError
  }
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

function isMemoryOrSqlError(error: unknown): boolean {
  const message = getMessage(error).toLowerCase()
  return message.includes('memory limit') || message.includes('syntax error') || message.includes('bad query')
}

export function isTransientClickHouseError(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'string')) {
    return false
  }

  const code = getCode(error)
  const causeCode = getCode((error as { cause?: unknown }).cause)
  const status = getStatus(error)
  const message = getMessage(error).toLowerCase()

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
  operation: () => Promise<T>,
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

  while (true) {
    attempts += 1

    try {
      return await operation()
    } catch (error) {
      if (!isTransientClickHouseError(error) || isMemoryOrSqlError(error)) {
        throw error
      }

      const delayMs = delayForAttempt(attempts, initialDelayMs, maxDelayMs)
      const deadline = startedAt + maxElapsedMs

      if (now() + delayMs > deadline) {
        throw new ClickHouseRetryExhaustedError(attempts, error)
      }

      onRetry?.({ attempt: attempts, delayMs, error })
      await sleep(delayMs)
    }
  }
}
