import { describe, test, expect } from 'vitest'
import {
  EXPORT_ROW_CAP, JSON_EXPORT_ROW_CAP, STREAM_FORMATS, CSV_COLUMNS, csvHeaderLine, exportLine, createExportStream, type ExportRow,
} from '@/lib/export-stream'

const row = (n: number, over: ExportRow = {}): ExportRow => ({
  url: `https://s${n}.example/login`, email: `u${n}@mail.test`, password: `pw${n}`, domain: `s${n}.example`, source_file: 'f.txt',
  breach_name: '', country_tier: '', login_type: 'email', password_length: 4, password_mask: 'alphanumeric', url_scheme: 'https',
  is_corporate_email: 0, email_domain: 'mail.test', url_host: `s${n}.example`, password_entropy_band: 'weak', imported_at: '2026-10-13 01:00:00', ...over,
})

type Log = { pulled: number; closed: boolean }
const fresh = (): Log => ({ pulled: 0, closed: false })

/** A source of batches that counts the batches read and notes when it was closed; failAt throws instead of yielding that batch. */
function source(batches: ExportRow[][], log: Log, failAt = -1): AsyncIterable<ExportRow[]> {
  return (async function* () {
    try {
      for (let i = 0; i < batches.length; i++) {
        if (i === failAt) throw new Error('boom')
        log.pulled++
        yield batches[i]
      }
    } finally {
      log.closed = true
    }
  })()
}
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

describe('the caps and the formats', () => {
  test('a million rows for the streamed formats, ten thousand for json', () => {
    expect(EXPORT_ROW_CAP).toBe(1_000_000)
    expect(JSON_EXPORT_ROW_CAP).toBe(10_000)
    expect([...STREAM_FORMATS]).toEqual(['csv', 'ndjson', 'ulp', 'userpass'])
  })
})

describe('csvHeaderLine and exportLine', () => {
  test('the csv header names the 16 columns in the export order', () => {
    expect(csvHeaderLine()).toBe(
      'url,email,password,domain,source_file,breach_name,country_tier,login_type,password_length,password_mask,url_scheme,is_corporate_email,email_domain,url_host,password_entropy_band,imported_at\n',
    )
    expect(CSV_COLUMNS).toHaveLength(16)
  })

  test('a csv row quotes every cell, doubles quotes and ends with a newline', () => {
    expect(exportLine('csv', row(1, { password: 'a"b' }))).toBe(
      '"https://s1.example/login","u1@mail.test","a""b","s1.example","f.txt","","","email","4","alphanumeric","https","0","mail.test","s1.example","weak","2026-10-13 01:00:00"\n',
    )
  })

  test('the formula guard puts a quote in front of = + - @, and csv_guard false removes it', () => {
    expect(exportLine('csv', row(1, { password: '=1+1', email: '-5', url: '@x' }))).toContain(`"'=1+1"`)
    expect(exportLine('csv', row(1, { password: '=1+1' }), false)).toContain('"=1+1"')
    expect(exportLine('csv', row(1, { password: '=1+1' }), false)).not.toContain(`"'=1+1"`)
  })

  test('ulp, userpass and ndjson are one newline-terminated line per row', () => {
    const r = row(2)
    expect(exportLine('ulp', r)).toBe('https://s2.example/login:u2@mail.test:pw2\n')
    expect(exportLine('userpass', r)).toBe('u2@mail.test:pw2\n')
    expect(exportLine('ndjson', r)).toBe(JSON.stringify(r) + '\n')
  })

  test('the formula guard is for csv only', () => {
    const r = row(3, { password: '=cmd' })
    expect(exportLine('ulp', r)).toContain(':=cmd\n')
    expect(exportLine('userpass', r)).toBe('u3@mail.test:=cmd\n')
  })
})

describe('createExportStream', () => {
  test('csv: the header first, then every row, newline-terminated', async () => {
    const out = await text(createExportStream(source([[row(1), row(2)], [row(3)]], fresh()), { format: 'csv' }))
    const lines = out.split('\n')
    expect(lines).toHaveLength(5) // header + 3 rows + the empty piece after the last newline
    expect(lines[0]).toBe(csvHeaderLine().trimEnd())
    expect(lines[3]).toContain('u3@mail.test')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('the other formats have no header line', async () => {
    const out = await text(createExportStream(source([[row(1), row(2)]], fresh()), { format: 'userpass' }))
    expect(out).toBe('u1@mail.test:pw1\nu2@mail.test:pw2\n')
  })

  test('an empty source gives only the csv header, or nothing', async () => {
    expect(await text(createExportStream(source([], fresh()), { format: 'csv' }))).toBe(csvHeaderLine())
    expect(await text(createExportStream(source([], fresh()), { format: 'ulp' }))).toBe('')
  })

  test('empty batches in between do not stall it', async () => {
    const out = await text(createExportStream(source([[], [], [row(1)], []], fresh()), { format: 'userpass' }))
    expect(out).toBe('u1@mail.test:pw1\n')
  })

  test('the cap stops it exactly, in the middle of a batch, and closes the source', async () => {
    const log = fresh()
    const out = await text(createExportStream(source([[row(1), row(2)], [row(3), row(4)], [row(5)]], log), { format: 'userpass', cap: 3 }))
    expect(out.split('\n').filter(Boolean)).toHaveLength(3)
    expect(out).toContain('u3@mail.test')
    expect(out).not.toContain('u4@mail.test')
    expect(log.closed).toBe(true)
    expect(log.pulled).toBe(2)
  })

  test('cap 0 writes the csv header and reads nothing', async () => {
    const log = fresh()
    expect(await text(createExportStream(source([[row(1)]], log), { format: 'csv', cap: 0 }))).toBe(csvHeaderLine())
    expect(log.pulled).toBe(0)
  })

  test('it reads lazily: one chunk read does not drain a long source', async () => {
    const log = fresh()
    const many = Array.from({ length: 200 }, (_, i) => [row(i)])
    const reader = createExportStream(source(many, log), { format: 'userpass' }).getReader()
    await reader.read()
    expect(log.pulled).toBeLessThan(10)
    await reader.cancel()
  })

  test('cancel stops the source', async () => {
    const log = fresh()
    const reader = createExportStream(source(Array.from({ length: 50 }, (_, i) => [row(i)]), log), { format: 'userpass' }).getReader()
    await reader.read()
    await reader.cancel()
    expect(log.closed).toBe(true)
  })

  test('an error in the source errors the stream', async () => {
    const log = fresh()
    const stream = createExportStream(source([[row(1)], [row(2)], [row(3)]], log, 1), { format: 'userpass' })
    await expect(text(stream)).rejects.toThrow('boom')
    expect(log.closed).toBe(true)
  })
})
