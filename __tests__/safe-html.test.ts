import { describe, expect, test } from 'vitest'
import { MAX_DEPTH, MAX_INPUT_CHARS, parseSafeHtml, type SafeNode } from '@/lib/safe-html'

const t = (text: string): SafeNode => ({ type: 'text', text })
const el = (tag: string, children: SafeNode[], href?: string): SafeNode =>
  (href === undefined ? { type: 'el', tag, children } : { type: 'el', tag, href, children }) as SafeNode
const br: SafeNode = { type: 'br' }
const plain = (nodes: SafeNode[]): string =>
  nodes.map(n => (n.type === 'text' ? n.text : n.type === 'br' ? '\n' : plain(n.children))).join('')
const depth = (nodes: SafeNode[]): number =>
  Math.max(0, ...nodes.map(n => (n.type === 'el' ? 1 + depth(n.children) : 0)))

describe('parseSafeHtml — what is kept', () => {
  test('plain text', () => {
    expect(parseSafeHtml('hello')).toEqual([t('hello')])
  })

  test('the allowed tags, in any case, nested', () => {
    expect(parseSafeHtml('<p><B>a</B> <i>b</i> <EM>c</EM> <strong>d</strong></p>')).toEqual([
      el('p', [el('b', [t('a')]), t(' '), el('i', [t('b')]), t(' '), el('em', [t('c')]), t(' '), el('strong', [t('d')])]),
    ])
  })

  test('br, br/ and BR / are line breaks', () => {
    expect(parseSafeHtml('a<br>b<br/>c<BR />d')).toEqual([t('a'), br, t('b'), br, t('c'), br, t('d')])
  })

  test('a link keeps an http, https or mailto href, with entities decoded', () => {
    expect(parseSafeHtml('<a href="https://example.test/a?b=1&amp;c=2">x</a>')).toEqual([el('a', [t('x')], 'https://example.test/a?b=1&c=2')])
    expect(parseSafeHtml("<a href='http://example.test'>x</a>")).toEqual([el('a', [t('x')], 'http://example.test')])
    expect(parseSafeHtml('<a href=mailto:a@b.test>x</a>')).toEqual([el('a', [t('x')], 'mailto:a@b.test')])
  })

  test('a ">" inside a quoted attribute does not end the tag', () => {
    expect(parseSafeHtml('<a title="a>b" href="https://example.test">x</a>')).toEqual([el('a', [t('x')], 'https://example.test')])
  })

  test('decodes the common entities once', () => {
    expect(parseSafeHtml('&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b')).toEqual([t('& <b> "q" \'s\' a b')])
    expect(parseSafeHtml('&amp;lt;')).toEqual([t('&lt;')])
  })

  test('a "<" that is not a tag stays text', () => {
    expect(parseSafeHtml('1 < 2 and 3 > 2')).toEqual([t('1 < 2 and 3 > 2')])
    expect(parseSafeHtml('a <b unterminated')).toEqual([t('a <b unterminated')])
  })

  test('an unclosed element is closed at the end, a stray closer is ignored, a closer closes what was opened inside', () => {
    expect(parseSafeHtml('<b>x')).toEqual([el('b', [t('x')])])
    expect(parseSafeHtml('x</b>y')).toEqual([t('xy')])
    expect(parseSafeHtml('<b><i>x</b>y')).toEqual([el('b', [el('i', [t('x')])]), t('y')])
  })
})

describe('parseSafeHtml — what is removed', () => {
  test.each([
    ['javascript:alert(1)'],
    ['  JaVaScRiPt:alert(1)'],
    ['java\tscript:alert(1)'],
    ['data:text/html,<b>x</b>'],
    ['vbscript:x'],
    ['//evil.test/x'],
    ['/relative'],
    ['&#106;avascript:alert(1)'],
  ])('a link with href %j loses its href but keeps its text', href => {
    expect(parseSafeHtml(`<a href="${href}">x</a>`)).toEqual([el('a', [t('x')])])
  })

  test('every attribute but href is dropped', () => {
    expect(parseSafeHtml('<b onclick="alert(1)" style="x:y" class="c">t</b>')).toEqual([el('b', [t('t')])])
  })

  test('script, style, img and iframe are dropped; their text stays as plain text', () => {
    expect(parseSafeHtml('<script>alert(1)</script>x')).toEqual([t('alert(1)x')])
    expect(parseSafeHtml('<img src=x onerror=alert(1)>')).toEqual([])
    expect(parseSafeHtml('<iframe src="https://evil.test"></iframe>ok')).toEqual([t('ok')])
    expect(parseSafeHtml('<style>body{display:none}</style>')).toEqual([t('body{display:none}')])
  })

  test('comments are dropped, and an unterminated one swallows the rest', () => {
    expect(parseSafeHtml('a<!-- x -->b')).toEqual([t('ab')])
    expect(parseSafeHtml('a<!-- b')).toEqual([t('a')])
  })
})

describe('parseSafeHtml — bounds', () => {
  test('input is cut at MAX_INPUT_CHARS', () => {
    expect(plain(parseSafeHtml('a'.repeat(1_000_000))).length).toBe(MAX_INPUT_CHARS)
  })

  test('nesting is cut at MAX_DEPTH', () => {
    const nodes = parseSafeHtml('<b>'.repeat(5000) + 'x')
    expect(depth(nodes)).toBe(MAX_DEPTH)
    expect(plain(nodes)).toBe('x')
  })

  test('thousands of unterminated tags stay fast', () => {
    const started = Date.now()
    parseSafeHtml('<b '.repeat(6000))
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('null, undefined and the empty string are an empty tree', () => {
    expect(parseSafeHtml(undefined as unknown as string)).toEqual([])
    expect(parseSafeHtml(null as unknown as string)).toEqual([])
    expect(parseSafeHtml('')).toEqual([])
  })
})
