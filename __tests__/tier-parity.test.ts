import { describe, test, expect } from 'vitest'
import { TierParity, parseParityLine, formatParityReport, shapeOf } from '@/lib/tier-parity'

// stored | expected | email | url   — the ClickHouse stored label, the label the current expression gives, then the login and URL
const line = (stored: string, expected: string, email: string, url: string) => `${stored}\t${expected}\t${email}\t${url}`

describe('parseParityLine', () => {
  test('splits the two labels from the tab-escaped login and URL', () => {
    expect(parseParityLine(line('T3', '', 'ivan.ru', 'https://login.example.com/x'))).toEqual({
      stored: 'T3', expected: '', email: 'ivan.ru', url: 'https://login.example.com/x',
    })
  })

  test('understands ClickHouse TSV escapes inside the login and URL', () => {
    const row = parseParityLine(line('', '', 'a\\tb@x.com', 'https://x.com/a\\\\b'))
    expect(row.email).toBe('a\tb@x.com')
    expect(row.url).toBe('https://x.com/a\\b')
  })

  test('a line with too few fields is an error, not a silent skip', () => {
    expect(() => parseParityLine('T3\tT3')).toThrow()
  })
})

describe('TierParity — stored label vs the label the importer assigns (classifyTier)', () => {
  test('agreement everywhere counts nothing', () => {
    const p = new TierParity()
    p.add({ stored: 'T1', expected: 'T1', email: 'a@gmail.com', url: 'https://shop.example.co.uk' })
    p.add({ stored: '', expected: '', email: 'someone', url: 'https://x.com' })
    expect(p.summary()).toMatchObject({ checked: 2, storedVsImporter: 0, expressionVsImporter: 0, storedVsExpression: 0 })
  })

  test('the mislabelled shape: a login with no "@" stored as T3 while the importer and the new expression say untiered', () => {
    const p = new TierParity()
    p.add({ stored: 'T3', expected: '', email: 'ivan.ru', url: 'https://login.microsoftonline.com/common' })
    const s = p.summary()
    expect(s.storedVsImporter).toBe(1)
    expect(s.storedVsExpression).toBe(1)
    expect(s.expressionVsImporter).toBe(0)
    expect(s.storedVsImporterPairs).toEqual({ 'T3->untiered': 1 })
    expect(s.noAtSign).toBe(1)
  })

  test('the SQL expression and the importer disagreeing is counted separately, with the shape that explains it', () => {
    const p = new TierParity()
    // SQL says T3 from the URL TLD, the importer says untiered
    p.add({ stored: 'T3', expected: 'T3', email: 'bob@gmail.com', url: 'HTTPS://WWW.EXAMPLE.RU./' })
    const s = p.summary()
    expect(s.expressionVsImporter).toBe(1)
    expect(s.expressionVsImporterPairs).toEqual({ 'T3->untiered': 1 })
  })

  test('only counts and shapes are kept, never the row itself', () => {
    const p = new TierParity()
    p.add({ stored: 'T3', expected: '', email: 'secret.login.ru', url: 'https://private.example/' })
    expect(JSON.stringify(p.summary())).not.toMatch(/secret|private/)
  })

  test('stops reading after the cap so a wrong expression cannot flood the report', () => {
    const p = new TierParity(5)
    for (let i = 0; i < 10; i++) p.add({ stored: 'T3', expected: '', email: 'x.ru', url: '' })
    expect(p.done).toBe(true)
    expect(p.summary().stoppedEarly).toBe(true)
  })

  test('the report ends with a machine-readable verdict line', () => {
    const p = new TierParity()
    p.add({ stored: '', expected: '', email: 'a@b.com', url: '' })
    const report = formatParityReport(p.summary())
    expect(report.trim().split('\n').pop()).toBe('parity-result: checked=1 stored_vs_importer=0 expression_vs_importer=0 stored_vs_expression=0 stopped_early=0')
  })
})

describe('shapeOf — a description of a row that explains a disagreement without revealing it', () => {
  // Letters and digits collapse to a / 9 runs, host labels to x (X if upper case), only the last label (the TLD) and the
  // punctuation survive. Enough to see "no scheme", "userinfo", "trailing dot" or "upper case" without seeing the row.
  test('keeps punctuation, scheme and the last label (the TLD); everything else becomes a placeholder', () => {
    expect(shapeOf({ stored: '', expected: '', email: 'john.smith42@mail.example.ru', url: 'https://www.shop.example.co.uk:8443/a/b?q=1' }))
      .toBe('a.a9@x.x.ru | https://x.x.x.x.uk:9/a/a?a=9')
  })

  test('shows the shapes that trip a URL parser: no scheme, userinfo, trailing dot, upper case', () => {
    expect(shapeOf({ stored: '', expected: '', email: 'abc', url: 'EXAMPLE.RU./login' })).toBe('a | X.RU./a')
    expect(shapeOf({ stored: '', expected: '', email: 'a@b.com', url: 'http://user:pw@host.ru/' })).toBe('a@x.com | http://a:a@x.ru/')
    expect(shapeOf({ stored: '', expected: '', email: '', url: '' })).toBe('(empty) | (empty)')
  })

  test('a single-label host is not shown (it could be an internal name); neither is an IPv6 literal', () => {
    expect(shapeOf({ stored: '', expected: '', email: 'a', url: 'http://jira/browse' })).toBe('a | http://x/a')
    expect(shapeOf({ stored: '', expected: '', email: 'a', url: 'http://[2001:db8::1]:8080/x' })).toBe('a | http://[ip6]:9/a')
  })

  test('never contains the local part, a host label or a password-like run of characters', () => {
    const shape = shapeOf({ stored: '', expected: '', email: 'hunter2secret@bank-of-somewhere.pl', url: 'https://very-private-host.example.pl/token/abc123' })
    expect(shape).toBe('a9a@x.pl | https://x.x.pl/a/a9')
    expect(shape).not.toMatch(/hunter|secret|bank|somewhere|private|token|abc|123/)
  })

  test('long values are cut so a report line stays short', () => {
    expect(shapeOf({ stored: '', expected: '', email: '.'.repeat(300) + '@b.com', url: 'https://x.com/' + '/'.repeat(300) }).length).toBeLessThan(140)
  })
})

describe('TierParity — the expression-vs-importer shapes', () => {
  test('are counted per shape, most common first, and appear in the report', () => {
    const p = new TierParity()
    for (let i = 0; i < 3; i++) p.add({ stored: 'T3', expected: 'T3', email: 'bob@gmail.com', url: 'HTTPS://WWW.EXAMPLE.RU./' })
    p.add({ stored: 'T3', expected: 'T3', email: 'bob@gmail.com', url: 'http://user:pw@host.ru./' })
    const s = p.summary()
    expect(Object.values(s.expressionVsImporterShapes)[0]).toBe(3)
    expect(Object.keys(s.expressionVsImporterShapes).length).toBe(2)
    expect(formatParityReport(s)).toContain('shapes of expression-vs-importer disagreements')
  })
})
