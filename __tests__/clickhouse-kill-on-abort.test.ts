import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * executeQuery(sql, params, signal): a statement that is given a signal runs under an id of its own, and an abort KILLs it on the server.
 * Dropping the HTTP connection is not enough: ClickHouse 26.3 keeps running a SELECT sent with http_wait_end_of_query=1 after its client left
 * (measured 2026-10-26, see killQuery in lib/clickhouse.ts), so a search the browser had replaced kept scanning 150 GiB for nobody.
 * The seam is the client library, the one thing faked here.
 */
type QueryOptions = { query: string; query_id?: string; abort_signal?: AbortSignal; query_params?: unknown }
type CommandOptions = { query: string; abort_signal?: AbortSignal }

const h = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
  createClient: vi.fn(),
}))
vi.mock('@clickhouse/client', () => ({ createClient: h.createClient }))

const globals = globalThis as unknown as { clickhouse?: unknown }

/** A query that stays pending until the signal fires, like the library's own behaviour (it rejects with an AbortError). */
function pendingUntilAborted(opts: QueryOptions): Promise<{ json: () => Promise<unknown[]> }> {
  return new Promise((_resolve, reject) => {
    opts.abort_signal?.addEventListener('abort', () => {
      const err = new Error('The user aborted a request.')
      err.name = 'AbortError'
      reject(err)
    }, { once: true })
  })
}

beforeEach(() => {
  vi.resetModules()
  h.query.mockReset()
  h.command.mockReset().mockResolvedValue(undefined)
  h.createClient.mockReset().mockReturnValue({ query: h.query, command: h.command })
  globals.clickhouse = undefined
  vi.stubEnv('CLICKHOUSE_HOST', 'http://clickhouse.test:8123')
  vi.stubEnv('CLICKHOUSE_USER', 'default')
  vi.stubEnv('CLICKHOUSE_PASSWORD', '')
  vi.stubEnv('CLICKHOUSE_DATABASE', 'ulp')
})

afterEach(() => {
  vi.unstubAllEnvs()
  globals.clickhouse = undefined
})

const killsSent = () => h.command.mock.calls.map(c => (c[0] as CommandOptions).query).filter(q => q.startsWith('KILL QUERY'))

describe('executeQuery with an AbortSignal', () => {
  it('runs the statement under an id of its own and passes the signal to the client', async () => {
    h.query.mockResolvedValue({ json: async () => [{ a: 1 }] })
    const { executeQuery } = await import('@/lib/clickhouse')
    const signal = new AbortController().signal
    await expect(executeQuery('SELECT 1', {}, signal)).resolves.toEqual([{ a: 1 }])
    const opts = h.query.mock.calls[0][0] as QueryOptions
    expect(opts.query_id).toMatch(/^ulp-q-[0-9a-f-]{36}$/)
    expect(opts.abort_signal).toBe(signal)
  })

  it('KILLs that statement when the signal aborts while it is running, and rejects with an abort error', async () => {
    h.query.mockImplementation(pendingUntilAborted)
    const { executeQuery } = await import('@/lib/clickhouse')
    const controller = new AbortController()
    const running = executeQuery('SELECT sleep(3)', {}, controller.signal)
    const sentId = (h.query.mock.calls[0][0] as QueryOptions).query_id
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(killsSent()).toEqual([`KILL QUERY WHERE query_id = '${sentId}' ASYNC`])
  })

  it('does not kill anything when the statement had already finished', async () => {
    h.query.mockResolvedValue({ json: async () => [] })
    const { executeQuery } = await import('@/lib/clickhouse')
    const controller = new AbortController()
    await executeQuery('SELECT 1', {}, controller.signal)
    controller.abort() // the request ends after the answer went out: nothing is left to cancel
    await Promise.resolve()
    expect(killsSent()).toEqual([])
  })

  it('does not even send a statement for a signal that has already aborted', async () => {
    const { executeQuery } = await import('@/lib/clickhouse')
    const controller = new AbortController()
    controller.abort()
    await expect(executeQuery('SELECT 1', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.query).not.toHaveBeenCalled()
    expect(killsSent()).toEqual([])
  })

  it('leaves a call without a signal exactly as it was: no id of its own and nothing to kill', async () => {
    h.query.mockResolvedValue({ json: async () => [{ n: 1 }] })
    const { executeQuery } = await import('@/lib/clickhouse')
    await executeQuery('SELECT 1')
    const opts = h.query.mock.calls[0][0] as QueryOptions
    expect(opts.query_id).toBeUndefined()
    expect(opts.abort_signal).toBeUndefined()
    expect(killsSent()).toEqual([])
  })

  it('does not report an abort as a ClickHouse failure (nothing on the error log)', async () => {
    h.query.mockImplementation(pendingUntilAborted)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { executeQuery } = await import('@/lib/clickhouse')
    const controller = new AbortController()
    const running = executeQuery('SELECT sleep(3)', {}, controller.signal)
    controller.abort()
    await expect(running).rejects.toBeDefined()
    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })
})

describe('killQuery', () => {
  it('sends KILL QUERY ... ASYNC for an id this app minted, bounded by a timeout', async () => {
    const { killQuery } = await import('@/lib/clickhouse')
    const id = 'ulp-q-123e4567-e89b-12d3-a456-426614174000'
    await killQuery(id)
    const opts = h.command.mock.calls[0][0] as CommandOptions
    expect(opts.query).toBe(`KILL QUERY WHERE query_id = '${id}' ASYNC`)
    expect(opts.abort_signal).toBeInstanceOf(AbortSignal)
  })

  it.each(["x' OR 1=1 --", 'novelty-123e4567-e89b-12d3-a456-426614174000', '', 'ulp-q-'])('refuses an id that is not one it minted: %j', async id => {
    const { killQuery } = await import('@/lib/clickhouse')
    await killQuery(id)
    expect(h.command).not.toHaveBeenCalled()
  })

  it('swallows a failure of the kill itself (the request is already gone) and says so on the warning log', async () => {
    h.command.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { killQuery } = await import('@/lib/clickhouse')
    await expect(killQuery('ulp-q-123e4567-e89b-12d3-a456-426614174000')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not cancel an abandoned query'), 'connect ECONNREFUSED')
    warn.mockRestore()
  })
})

describe('the client library\'s logger', () => {
  /** What the app hands the library as its logger (createClient\'s `log.LoggerClass`). */
  async function loggerClass() {
    const { getClient } = await import('@/lib/clickhouse')
    getClient()
    const opts = h.createClient.mock.calls[0][0] as { log?: { LoggerClass?: new () => { error(p: unknown): void; warn(p: unknown): void; info(p: unknown): void } } }
    expect(opts.log?.LoggerClass).toBeDefined()
    return opts.log!.LoggerClass!
  }

  it('does not print an error block for a request this app aborted on purpose', async () => {
    const Logger = await loggerClass()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = new Logger()
    logger.error({ module: 'Connection', message: 'Query: HTTP request error.', err: Object.assign(new Error('x'), { name: 'AbortError' }) })
    logger.error({ module: 'Connection', message: 'Query: HTTP request error.', err: new Error('The user aborted a request.') })
    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('still prints every other error, such as a connection reset by a ClickHouse that restarted, and every warning', async () => {
    const Logger = await loggerClass()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = new Logger()
    logger.error({ module: 'Connection', message: 'Query: HTTP request error.', args: { query_id: 'q1' }, err: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(String(errorLog.mock.calls[0][0])).toMatch(/^\[.+\]\[ERROR\]\[@clickhouse\/client\]\[Connection\] Query: HTTP request error\.$/)
    expect(errorLog.mock.calls[0]).toContain('\nCaused by:')
    logger.warn({ module: 'Connection', message: 'slow' })
    expect(warnLog).toHaveBeenCalledTimes(1)
    logger.info({ module: 'Connection', message: 'quiet' }) // below the default WARN level: nothing
    errorLog.mockRestore()
    warnLog.mockRestore()
  })
})

describe('isAbortError', () => {
  it('recognises the three shapes an abort takes and nothing else', async () => {
    const { isAbortError } = await import('@/lib/clickhouse')
    const named = Object.assign(new Error('x'), { name: 'AbortError' })
    expect(isAbortError(named)).toBe(true)
    expect(isAbortError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isAbortError(new Error('The user aborted a request.'))).toBe(true)
    expect(isAbortError(new Error('Code: 159. Timeout exceeded (TIMEOUT_EXCEEDED)'))).toBe(false)
    expect(isAbortError('aborted')).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })
})
