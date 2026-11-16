/**
 * `docker exec <container> clickhouse-client` as a small async interface, for the archive tools that run on the host, outside the app container (the pattern of
 * lib/known-share.ts and scripts/archive-sources.ts). A failure reports the ClickHouse error code and its name and nothing else: the text of a parse error can quote
 * the row it choked on, and these tools handle credentials.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { once } from 'node:events'

export interface Ch {
  /** Runs a statement and returns what the client printed. */
  run(sql: string): Promise<string>
  /** Runs `INSERT ... FORMAT TSV` and feeds the rows to its standard input; resolves when ClickHouse has taken them all. */
  insertTsv(sql: string, rows: AsyncIterable<string | Buffer>): Promise<void>
  /** Runs a query and writes its answer to `path`. */
  queryToFile(sql: string, path: string): Promise<void>
}

export interface DockerChOptions {
  /** The docker binary. Default `docker`. */
  bin?: string
  /** Seconds one statement may run. Default 1800. */
  maxSeconds?: number
  /** Bytes of memory one statement may use. Default 6 GB. */
  maxMemoryBytes?: number
}

const STDERR_KEEP = 64 * 1024

/** `Code: 27. DB::Exception: ... (CANNOT_PARSE_INPUT)` -> `ClickHouse error 27 (CANNOT_PARSE_INPUT)`; anything else is only the exit status. */
function describeFailure(container: string, status: number | null, signal: string | null, stderr: string): string {
  const head = `clickhouse-client in ${container} failed (${signal ? `signal ${signal}` : `exit ${status}`})`
  const m = /Code: (\d+)\. DB::Exception:[\s\S]*?\(([A-Z][A-Z0-9_]+)\)/.exec(stderr)
  return m ? `${head}: ClickHouse error ${m[1]} (${m[2]})` : head
}

export function dockerCh(container: string, opts: DockerChOptions = {}): Ch {
  const bin = opts.bin ?? 'docker'
  const args = (sql: string) => [
    'exec', '-i', container, 'clickhouse-client',
    `--max_execution_time=${opts.maxSeconds ?? 1800}`, `--max_memory_usage=${opts.maxMemoryBytes ?? 6_000_000_000}`,
    '--query', sql,
  ]

  /** Starts the client and returns the process with a promise that settles when it has exited. */
  function start(sql: string, stdio: ['pipe' | 'ignore', 'pipe' | number, 'pipe']): { child: ChildProcess; exited: Promise<{ stdout: string }> } {
    const child = spawn(bin, args(sql), { stdio })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < STDERR_KEEP) stderr += d.toString('utf8') })
    const exited = new Promise<{ stdout: string }>((resolve, reject) => {
      child.on('error', err => reject(new Error(`cannot start ${bin}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)))
      child.on('close', (status, signal) => {
        if (status === 0) resolve({ stdout })
        else reject(new Error(describeFailure(container, status, signal, stderr)))
      })
    })
    exited.catch(() => {})   // the caller awaits it; this only keeps a failure that lands first from being reported as unhandled
    return { child, exited }
  }

  return {
    async run(sql) {
      const { exited } = start(sql, ['ignore', 'pipe', 'pipe'])
      return (await exited).stdout
    },

    async queryToFile(sql, path) {
      const fd = openSync(path, 'w')
      try {
        const { exited } = start(sql, ['ignore', fd, 'pipe'])
        await exited
      } finally {
        closeSync(fd)
      }
    },

    async insertTsv(sql, rows) {
      const { child, exited } = start(sql, ['pipe', 'pipe', 'pipe'])
      const stdin = child.stdin!
      let pipeBroke = false
      stdin.on('error', () => { pipeBroke = true })   // the client died first: its exit status says why
      try {
        for await (const chunk of rows) {
          if (pipeBroke || stdin.destroyed) break
          // `once` rejects on the pipe's own error (EPIPE); the exit status of the client, awaited below, is the better account of it.
          if (!stdin.write(chunk)) await Promise.race([once(stdin, 'drain').catch(() => undefined), exited.then(() => undefined, () => undefined)])
        }
      } finally {
        if (!stdin.destroyed) stdin.end()
      }
      await exited
    },
  }
}
