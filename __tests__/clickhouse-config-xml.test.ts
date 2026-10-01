import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * On 2026-10-01 docker/clickhouse/config/ulp-performance.xml had a "--" inside an XML comment (illegal in XML). The running server
 * kept its old config and logged the parse error ~11,000 times, and the NEXT restart of the container would have crash-looped
 * (exit 232), taking the app down with it. Nothing noticed until a fresh ClickHouse was started in an isolated rehearsal stack.
 */
function xmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? xmlFiles(p) : name.endsWith('.xml') ? [p] : []
  })
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

/** The problems that actually bite in hand-edited config: comments with "--", unclosed comments, unbalanced tags, bare "&". */
function problem(xml: string): string | null {
  let stripped = ''
  let i = 0
  while (i < xml.length) {
    const open = xml.indexOf('<!--', i)
    if (open === -1) {
      stripped += xml.slice(i)
      break
    }
    stripped += xml.slice(i, open)
    const close = xml.indexOf('-->', open + 4)
    if (close === -1) return `unterminated comment starting at line ${lineOf(xml, open)}`
    const body = xml.slice(open + 4, close)
    const dashes = body.indexOf('--')
    if (dashes !== -1) return `"--" inside a comment at line ${lineOf(xml, open + 4 + dashes)}`
    if (body.endsWith('-')) return `a comment ends with "-" at line ${lineOf(xml, open)}`
    i = close + 3
  }
  stripped = stripped.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '')
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(stripped)) return 'a bare "&" (write &amp;)'
  const stack: string[] = []
  for (const m of stripped.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)([^<>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = m
    if (selfClosing) continue
    if (!closing) stack.push(name)
    else if (stack.pop() !== name) return `</${name}> does not match the open tag`
  }
  return stack.length ? `<${stack[stack.length - 1]}> is never closed` : null
}

describe('the ClickHouse config files must be well-formed XML', () => {
  const files = xmlFiles('docker/clickhouse')

  test('there are config files to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
  })

  test.each(files)('%s', file => {
    expect(problem(readFileSync(file, 'utf8')), file).toBeNull()
  })

  test('the checker itself catches the mistake that took the server down', () => {
    expect(problem('<c><!-- fine -->\n<a/></c>')).toBeNull()
    expect(problem('<c><!-- a -- b --></c>')).toMatch(/"--" inside a comment/)
    expect(problem('<c><!-- never closed</c>')).toMatch(/unterminated/)
    expect(problem('<c><a></c>')).toMatch(/does not match|never closed/)
    expect(problem('<c>a & b</c>')).toMatch(/bare "&"/)
  })
})
