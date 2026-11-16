/**
 * lib/clickhouse-cli.ts (docs/superpowers/plans/2026-11-15-reduced-archive.md, task 3): `docker exec clickhouse-client` as a small async interface. A fake `docker` shell
 * script stands in for the container, so the arguments, the streaming insert with back-pressure, and the error text can be checked without ClickHouse.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { dockerCh } from '@/lib/clickhouse-cli'

let dir: string
let bin: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ch-cli-'))
  bin = join(dir, 'docker')
  // The last argument is the query. FAIL: an error that quotes a row. INSERT: copy stdin to $FAKE_OUT. EARLY: die without reading stdin. Anything else: echo what was asked.
  writeFileSync(bin, `#!/bin/sh
for last; do :; done
case "$last" in
  FAIL*) echo "Code: 27. DB::Exception: Cannot parse input: expected tab before: 'secret-credential-value': (at row 1) (CANNOT_PARSE_INPUT_ASSERTION_FAILED)" >&2; exit 3;;
  EARLY*) exit 5;;
  INSERT*) cat > "$FAKE_OUT";;
  *) echo "args: $*";;
esac
`)
  chmodSync(bin, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('dockerCh', () => {
  test('run executes in the container with the limits and returns what the client printed', async () => {
    const ch = dockerCh('some_container', { bin, maxSeconds: 77, maxMemoryBytes: 123456 })
    const out = await ch.run('SELECT 1')
    expect(out).toContain('exec -i some_container clickhouse-client')
    expect(out).toContain('--max_execution_time=77')
    expect(out).toContain('--max_memory_usage=123456')
    expect(out).toContain('--query SELECT 1')
  })

  test('insertTsv streams every row to the client, however many', async () => {
    process.env.FAKE_OUT = join(dir, 'insert.out')
    const ch = dockerCh('c', { bin })
    const row = 'x'.repeat(99) + '\n'
    async function* rows() { for (let i = 0; i < 200; i++) yield row.repeat(1000) }   // 200 chunks of 100 KB: 20 MB through a pipe
    await ch.insertTsv('INSERT INTO t FORMAT TSV', rows())
    expect(readFileSync(process.env.FAKE_OUT).length).toBe(200 * 1000 * 100)
  })

  test('queryToFile writes the answer to the file', async () => {
    const ch = dockerCh('c', { bin })
    const path = join(dir, 'answer.tsv')
    await ch.queryToFile('SELECT 2', path)
    expect(readFileSync(path, 'utf8')).toContain('--query SELECT 2')
  })

  test('an error names the ClickHouse code and nothing else: the text of a parse error can quote a row', async () => {
    const ch = dockerCh('c', { bin })
    const err = await ch.run('FAIL please').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('27')
    expect(message).toContain('CANNOT_PARSE_INPUT_ASSERTION_FAILED')
    expect(message).not.toContain('secret-credential-value')
  })

  test('a client that dies before it reads its input is reported as that failure, not as a broken pipe', async () => {
    const ch = dockerCh('c', { bin })
    async function* rows() { for (let i = 0; i < 50; i++) yield 'y'.repeat(1 << 20) }
    await expect(ch.insertTsv('EARLY insert', rows())).rejects.toThrow(/exit 5/)
  })
})
