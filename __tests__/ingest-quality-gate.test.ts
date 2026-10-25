import { describe, expect, it } from 'vitest'
import { holdsCredential } from '@/lib/ulp-recover'
import {
  GATE_KINDS, SHAPE_CAP, IngestHeldError, classifyStoredRow, describeVerdict, evaluateGate, isIngestHeldError, maskShape, maskText, newGateCounters,
  parseGateConfig, recordGateBatch, urlHoldsCredential, type GateConfig, type GateCounters, type GateKind,
} from '@/lib/ingest-quality-gate'

type Row = [string, string, string]
const CLEAN: Row = ['https://shop.example.test/login', 'alice@mail.test', 'Pw-abc!']

describe('classifyStoredRow: one fixture per kind', () => {
  const FIXTURES: Array<[GateKind, Row]> = [
    ['login-is-scheme-or-ends-colon', ['https://shop.example.test', 'https://other.example.test/x', 'Pw-1']],
    ['login-is-scheme-or-ends-colon', ['https://shop.example.test', 'alice@mail.test:', 'Pw-1']],
    ['login-has-scheme', ['https://shop.example.test', 'alice see https://x.example.test', 'Pw-1']],
    ['login-has-slash', ['https://shop.example.test', 'alice/bob', 'Pw-1']],
    ['login-has-colon', ['https://shop.example.test', 'alice:bob', 'Pw-1']],
    ['login-is-bare-host', ['', 'mail.example.test', 'Pw-1']],
    ['url-holds-credential', ['https://a.example.test:alice:secret', 'bob@mail.test', 'Pw-1']],
    ['password-has-scheme', ['https://shop.example.test', 'alice@mail.test', 'Pw://x1']],
    ['telegram-link-in-field', ['https://shop.example.test', 'alice@mail.test', 'pw t.me/channel']],
    ['telegram-link-in-field', ['android://hash==@com.example.app/', 'alice t.me/channel', 'Pw-1']],
    ['double-encoded-text', ['https://shop.example.test', 'alice@mail.test', 'Caf\u00C3\u00A9-1']],
  ]

  it.each(FIXTURES)('%s', (kind, [url, login, password]) => {
    expect(classifyStoredRow(url, login, password)).toBe(kind)
  })

  it('has a fixture for every kind', () => {
    expect(new Set(FIXTURES.map(f => f[0]))).toEqual(new Set(GATE_KINDS))
  })

  it('leaves a clean row alone, whatever else it carries', () => {
    expect(classifyStoredRow(...CLEAN)).toBeNull()
    expect(classifyStoredRow('', 'alice@mail.test', 'Pw')).toBeNull()
    expect(classifyStoredRow('https://x.example.test', 'mail.example.test', 'Pw')).toBeNull() // a bare-host login is only suspicious without a url
    expect(classifyStoredRow('android://hash==@com.example.app/', 'a/b', 'Pw-1')).toBeNull() // the android exception of login-has-slash
    expect(classifyStoredRow('https://shop.example.test:8080/login', 'alice', 'Pw-1')).toBeNull() // a port is not a credential
  })

  it('counts a row under the first kind that matches', () => {
    expect(classifyStoredRow('https://shop.example.test', 'https://x.example.test:', 'Pw://')).toBe('login-is-scheme-or-ends-colon')
  })

  it('urlHoldsCredential answers exactly like holdsCredential', () => {
    const urls = [
      '', 'host.test', 'https://host.test', 'https://host.test/path', 'https://host.test:8080/path', 'https://host.test:alice:secret',
      'host.test:alice:secret', 'alice@mail.test:', 'alice@mail.test:pw', 'http://a:b@host.test/', 'android://hash==@com.example.app/',
      'a:b', 'a:b:c', '://', 'x://y://z', 'https://host.test/a:b', ':',
    ]
    for (const url of urls) expect(urlHoldsCredential(url), JSON.stringify(url)).toBe(holdsCredential(url))
  })
})

describe('maskShape', () => {
  it('replaces every run of letters and digits (any script) by w and keeps only the punctuation', () => {
    expect(maskShape('https://shop.example.test/a', '\u0430\u043B\u0438\u0441\u0430@mail.test', '\u043F\u0430\u0440\u043E\u043B\u044C123')).toBe('w://w/w | w@w | w')
  })

  it('caps each field so a long line cannot fill the report', () => {
    expect(maskShape('', '', '!'.repeat(500)).length).toBeLessThan(80)
  })

  it('maskText masks a free line the same way and cuts it at max', () => {
    expect(maskText('Foo: bar baz!! 123', 70)).toBe('w: w w!! w')
    expect(maskText('a'.repeat(100), 10)).toBe('w')
    expect(maskText('x!'.repeat(100), 6)).toBe('w!w!w!')
  })
})

describe('recordGateBatch', () => {
  const batch = (credentials: Row[], rejected = 0, breakdown = {}, noCredential?: number) => ({
    credentials: credentials.map(([url, email, password]) => ({ url, email, password })), rejected, breakdown,
    ...(noCredential === undefined ? {} : { noCredential }),
  })

  it('counts the unsplit lines that cannot hold a credential (a banner, a divider, a bare url) apart from the other unsplit lines', () => {
    const c = newGateCounters()
    recordGateBatch(c, batch([CLEAN], 5, { no_fields: 5 }, 3))
    recordGateBatch(c, batch([CLEAN], 2, { no_fields: 2 })) // a batch from a caller that does not know the count (the field is optional)
    expect(c).toMatchObject({ lines: 1 + 5 + 1 + 2, noFields: 7, noCredential: 3 })
    expect(newGateCounters().noCredential).toBe(0)
  })

  it('counts the non-blank lines, the stored rows, the rejects by reason and the rows that break a rule', () => {
    const c = newGateCounters()
    recordGateBatch(c, batch([CLEAN, CLEAN, ['https://shop.example.test', 'alice:bob', 'Pw-1']], 6,
      { blank: 2, no_fields: 1, no_password: 1, garbage: 1, tier_dropped: 1, dedup: 0 }))
    expect(c).toMatchObject({ lines: 3 + 6 - 2, stored: 3, junk: 1, noFields: 1, noPassword: 1, garbage: 1, tierDropped: 1, dedup: 0, gateErrors: 0 })
    expect(c.kinds['login-has-colon']).toBe(1)
    expect(c.shapes.get('w://w | w:w | w')).toBe(1)
  })

  it('adds up over batches and keeps one counter set per import', () => {
    const a = newGateCounters()
    const b = newGateCounters()
    recordGateBatch(a, batch([CLEAN]))
    recordGateBatch(a, batch([CLEAN]))
    recordGateBatch(b, batch([CLEAN]))
    expect([a.stored, b.stored]).toEqual([2, 1])
  })

  it('counts a failure of the classifier and goes on', () => {
    const c = newGateCounters()
    recordGateBatch(c, { credentials: [{ url: 'u', email: undefined as unknown as string, password: 'p' }, { url: CLEAN[0], email: CLEAN[1], password: CLEAN[2] }], rejected: 0, breakdown: {} })
    expect(c).toMatchObject({ stored: 2, junk: 0, gateErrors: 1 })
  })

  it('remembers at most SHAPE_CAP distinct shapes and counts the rest together', () => {
    const c = newGateCounters()
    // 20 login shapes x 30 password shapes = 600 distinct masked shapes (a field is cut at 60 characters, so one field alone cannot make that many)
    const rows: Row[] = Array.from({ length: SHAPE_CAP + 100 }, (_, i): Row => ['https://shop.example.test', 'a' + '/'.repeat((i % 20) + 1), 'P' + '!'.repeat(Math.floor(i / 20) + 1)])
    recordGateBatch(c, batch(rows))
    expect(c.junk).toBe(SHAPE_CAP + 100)
    expect(c.shapes.size).toBe(SHAPE_CAP + 1)
    expect(c.shapes.get('(other shapes)')).toBe(100)
  })
})

describe('parseGateConfig', () => {
  it('defaults to the spec', () => {
    expect(parseGateConfig({})).toEqual({
      mode: 'hold', minLines: 20_000, earlyLines: 1_000_000,
      holdJunkPct: 2, holdUnsplitPct: 5, holdGarbagePct: 25, warnJunkPct: 1, warnUnsplitPct: 2,
    })
  })

  it('reads the environment', () => {
    const cfg = parseGateConfig({
      INGEST_QUALITY_GATE: ' WARN ', INGEST_QUALITY_GATE_JUNK_PCT: '3.5', INGEST_QUALITY_GATE_UNSPLIT_PCT: '8', INGEST_QUALITY_GATE_GARBAGE_PCT: '40',
      INGEST_QUALITY_GATE_WARN_JUNK_PCT: '0.5', INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT: '1', INGEST_QUALITY_GATE_MIN_LINES: '100',
      INGEST_QUALITY_GATE_EARLY_LINES: '5000',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg).toEqual({ mode: 'warn', minLines: 100, earlyLines: 5000, holdJunkPct: 3.5, holdUnsplitPct: 8, holdGarbagePct: 40, warnJunkPct: 0.5, warnUnsplitPct: 1 })
    expect(parseGateConfig({ INGEST_QUALITY_GATE: 'off' } as unknown as NodeJS.ProcessEnv).mode).toBe('off')
  })

  it('falls back to the default for a value that makes no sense, and to hold for an unknown mode', () => {
    const cfg = parseGateConfig({
      INGEST_QUALITY_GATE: 'maybe', INGEST_QUALITY_GATE_JUNK_PCT: 'abc', INGEST_QUALITY_GATE_UNSPLIT_PCT: '-1', INGEST_QUALITY_GATE_MIN_LINES: '0',
      INGEST_QUALITY_GATE_EARLY_LINES: '',
    } as unknown as NodeJS.ProcessEnv)
    expect(cfg).toMatchObject({ mode: 'hold', holdJunkPct: 2, holdUnsplitPct: 5, minLines: 20_000, earlyLines: 1_000_000 })
  })
})

describe('evaluateGate', () => {
  const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({ ...parseGateConfig({}), ...over })
  const counters = (c: Partial<Omit<GateCounters, 'kinds' | 'shapes'>>): GateCounters => ({ ...newGateCounters(), ...c })
  const BIG = { lines: 100_000, stored: 90_000 }
  const level = (c: Partial<Omit<GateCounters, 'kinds' | 'shapes'>>, over: Partial<GateConfig> = {}) => evaluateGate(counters(c), cfg(over), 'final').level

  it('passes a clean file', () => {
    expect(level({ ...BIG, junk: 100, noFields: 500, garbage: 1_000 })).toBe('pass')
  })

  it('holds above 2% junk, warns above 1%, and "above" means strictly above', () => {
    expect(level({ ...BIG, junk: 1_900 })).toBe('hold') // 2.11%
    expect(level({ ...BIG, junk: 1_800 })).toBe('warn') // exactly 2.00%
    expect(level({ ...BIG, junk: 1_000 })).toBe('warn') // 1.11%
    expect(level({ ...BIG, junk: 900 })).toBe('pass') //   exactly 1.00%
  })

  it('holds above 5% unsplit lines, warns above 2%', () => {
    expect(level({ ...BIG, noFields: 5_100 })).toBe('hold')
    expect(level({ ...BIG, noFields: 5_000 })).toBe('warn')
    expect(level({ ...BIG, noFields: 2_100 })).toBe('warn')
    expect(level({ ...BIG, noFields: 2_000 })).toBe('pass')
  })

  it('does not count a line that cannot hold a credential as unsplit', () => {
    expect(level({ ...BIG, noFields: 6_000, noCredential: 3_000 })).toBe('warn') // 3.00% of the lines
    expect(level({ ...BIG, noFields: 6_000, noCredential: 4_500 })).toBe('pass') // 1.50%
    expect(level({ ...BIG, noFields: 12_000, noCredential: 5_000 })).toBe('hold') // 7.00%
    expect(level({ ...BIG, noFields: 12_000, noCredential: 7_000 })).toBe('warn') // exactly 5.00%: strictly above is a hold
    expect(level({ ...BIG, noFields: 3_000, noCredential: 9_000 })).toBe('pass') // a count that is too big cannot make the share negative
  })

  it('reports the share without them, the counts of both, and names the lines it is about', () => {
    const v = evaluateGate(counters({ ...BIG, noFields: 12_000, noCredential: 5_000 }), cfg(), 'final')
    expect(v.report).toMatchObject({ noFields: 12_000, noCredential: 5_000, unsplitPct: 7 })
    expect(v.reasons).toEqual(['7.00% of the lines could not be split into a login and a password (limit 5%)'])
    const warn = evaluateGate(counters({ ...BIG, noFields: 6_000, noCredential: 3_000 }), cfg(), 'final')
    expect(warn.reasons).toEqual(['3.00% of the lines could not be split into a login and a password (warn limit 2%)'])
  })

  it('takes a sample phase', () => {
    const v = evaluateGate(counters({ ...BIG, junk: 5_000 }), cfg(), 'sample')
    expect(v.report.phase).toBe('sample')
    expect(describeVerdict(v)).toMatch(/^hold \(sample\): 100000 lines, 90000 stored, junk 5\.56%/)
  })

  it('holds above 25% garbage and has no warn tier for it', () => {
    expect(level({ ...BIG, garbage: 25_100 })).toBe('hold')
    expect(level({ ...BIG, garbage: 25_000 })).toBe('pass')
  })

  it('is at most a warn under 20,000 lines, and says nothing about a small file that only crosses a warn limit', () => {
    expect(level({ lines: 10_000, stored: 5_000, junk: 2_000 })).toBe('warn')
    expect(level({ lines: 10_000, stored: 9_000, junk: 150 })).toBe('pass') // 1.67%: a warn limit, too little data
  })

  it('never holds in warn mode and never reports in off mode', () => {
    expect(level({ ...BIG, junk: 5_000 }, { mode: 'warn' })).toBe('warn')
    expect(level({ ...BIG, junk: 5_000 }, { mode: 'off' })).toBe('pass')
  })

  it('turns a pass into a warn when the gate itself failed on more than 0.1% of the rows', () => {
    expect(level({ lines: 10_000, stored: 10_000, gateErrors: 11 })).toBe('warn')
    expect(level({ lines: 10_000, stored: 10_000, gateErrors: 10 })).toBe('pass')
  })

  it('reports numbers, the non-zero kinds, the top 20 shapes, the thresholds, and no text', () => {
    const c = newGateCounters()
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ['https://shop.example.test', 'secretlogin' + '/'.repeat(i + 1), 'topsecretpw'])
    recordGateBatch(c, { credentials: rows.map(([url, email, password]) => ({ url, email, password })), rejected: 0, breakdown: {} })
    const verdict = evaluateGate(c, cfg({ minLines: 10 }), 'early')
    expect(verdict.level).toBe('hold')
    expect(verdict.reasons[0]).toMatch(/^100\.00% of the stored rows break a rule \(limit 2%\)$/)
    expect(verdict.report).toMatchObject({ v: 1, phase: 'early', level: 'hold', lines: 25, stored: 25, junk: 25, junkPct: 100, unsplitPct: 0, garbagePct: 0 })
    expect(verdict.report.kinds).toEqual({ 'login-has-slash': 25 })
    expect(verdict.report.shapes).toHaveLength(20)
    expect(verdict.report.thresholds).toEqual({ minLines: 10, holdJunkPct: 2, holdUnsplitPct: 5, holdGarbagePct: 25, warnJunkPct: 1, warnUnsplitPct: 2 })
    expect(JSON.stringify(verdict.report)).not.toMatch(/secretlogin|topsecretpw/)
  })
})

describe('the two old parser defects, built as rows (the current parser no longer produces them)', () => {
  const cfg = parseGateConfig({})
  const rowsOf = (clean: number, bad: Row[]) => ({
    credentials: [...Array.from({ length: clean }, () => CLEAN), ...bad].map(([url, email, password]) => ({ url, email, password })),
    rejected: 0, breakdown: {},
  })

  it('holds a file whose passwords carry a channel tag', () => {
    const c = newGateCounters()
    recordGateBatch(c, rowsOf(94_000, Array.from({ length: 6_000 }, (): Row => ['https://shop.example.test', 'bob@mail.test', 'secret t.me/somechannel'])))
    expect(evaluateGate(c, cfg, 'final').level).toBe('hold')
  })

  it('holds a file where a url line, a login line and a password line were joined into one row', () => {
    const c = newGateCounters()
    recordGateBatch(c, rowsOf(90_000, Array.from({ length: 10_000 }, (): Row => ['', 'https://a.example.test/login carol@mail.test Pw-1', 'Pw-2'])))
    expect(evaluateGate(c, cfg, 'final').level).toBe('hold')
  })

  it('passes a file shaped like a clean one, even with a few rows that break a rule', () => {
    const c = newGateCounters()
    recordGateBatch(c, rowsOf(99_900, Array.from({ length: 100 }, (): Row => ['https://shop.example.test', 'dave:erin', 'Pw-1'])))
    expect(evaluateGate(c, cfg, 'final').level).toBe('pass')
  })
})

describe('IngestHeldError', () => {
  const report = evaluateGate(Object.assign(newGateCounters(), { lines: 30_000, stored: 30_000, junk: 3_000 }), parseGateConfig({}), 'final').report

  it('carries the report and says why in its message', () => {
    const err = new IngestHeldError(report)
    expect(err.name).toBe('IngestHeldError')
    expect(err.report).toBe(report)
    expect(err.message).toBe('Held by the quality gate: 10.00% of the stored rows break a rule (limit 2%).')
  })

  it('is recognised by shape too, because the app is built as several bundles', () => {
    expect(isIngestHeldError(new IngestHeldError(report))).toBe(true)
    const lookalike = Object.assign(new Error('x'), { name: 'IngestHeldError', report })
    expect(isIngestHeldError(lookalike)).toBe(true)
    expect(isIngestHeldError(new Error('x'))).toBe(false)
    expect(isIngestHeldError('IngestHeldError')).toBe(false)
  })
})
