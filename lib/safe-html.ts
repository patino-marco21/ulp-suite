/**
 * A small allow-list HTML parser for text that comes from a third party: the Have I Been Pwned breach descriptions, and whatever an admin
 * pastes into the breach editor. It never produces a string of HTML. It returns a tree of plain data that a React component turns into
 * elements, so nothing the input contains can become markup, script or an event handler.
 *
 * Kept: a (href limited to http:, https: and mailto:), b, strong, i, em, br, p. Every other tag is dropped and its text kept, every
 * attribute except href is dropped, comments are dropped, the common entities are decoded (React escapes the text again when it renders).
 * The input is cut at MAX_INPUT_CHARS, nesting at MAX_DEPTH and a tag at MAX_TAG_CHARS, so a hostile description costs a bounded parse.
 */
export type SafeTag = 'a' | 'b' | 'strong' | 'i' | 'em' | 'p'
export type SafeNode =
  | { type: 'text'; text: string }
  | { type: 'br' }
  | { type: 'el'; tag: SafeTag; href?: string; children: SafeNode[] }

type SafeElement = Extract<SafeNode, { type: 'el' }>

export const MAX_INPUT_CHARS = 20_000
export const MAX_DEPTH = 20
const MAX_TAG_CHARS = 2_000

const ALLOWED = new Set<string>(['a', 'b', 'strong', 'i', 'em', 'p'])
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const decode = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m])

/** The href when its scheme is http, https or mailto; undefined for anything else, relative links included. */
function safeHref(raw: string): string | undefined {
  // Browsers ignore tabs, newlines and control characters inside a URL scheme ("java\nscript:"), so remove them before looking.
  const url = decode(raw).replace(/[\u0000- \u007f-\u009f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (!scheme) return undefined
  return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase()) ? url : undefined
}

function hrefOf(attrs: string): string | undefined {
  const m = /(?:^|[\s"'])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs)
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : undefined
  return raw === undefined ? undefined : safeHref(raw)
}

interface Tag {
  end: number
  close: boolean
  name: string
  attrs: string
}

/** Reads the tag that starts at s[i] === '<'. null = not a tag (a literal "<", or a tag that never ends): the caller keeps it as text. */
function readTag(s: string, i: number): Tag | null {
  const m = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(s.slice(i, i + 40))
  if (!m) return null
  const attrsStart = i + m[0].length
  const limit = Math.min(s.length, i + MAX_TAG_CHARS)
  let j = attrsStart
  let quote = ''
  for (; j < limit; j++) {
    const c = s[j]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      break
    }
  }
  if (j >= limit) return null
  return { end: j + 1, close: m[1] === '/', name: m[2].toLowerCase(), attrs: s.slice(attrsStart, j) }
}

export function parseSafeHtml(input: string): SafeNode[] {
  const s = String(input ?? '').slice(0, MAX_INPUT_CHARS)
  const root: SafeNode[] = []
  const stack: SafeElement[] = []
  const out = (): SafeNode[] => (stack.length ? stack[stack.length - 1].children : root)

  const pushText = (text: string) => {
    if (!text) return
    const list = out()
    const last = list[list.length - 1]
    if (last && last.type === 'text') last.text += text
    else list.push({ type: 'text', text })
  }

  let i = 0
  let textStart = 0
  const flush = (end: number) => pushText(decode(s.slice(textStart, end)))

  while (i < s.length) {
    if (s[i] !== '<') {
      i++
      continue
    }
    if (s.startsWith('<!--', i)) {
      flush(i)
      const close = s.indexOf('-->', i + 4)
      i = close === -1 ? s.length : close + 3
      textStart = i
      continue
    }
    const tag = readTag(s, i)
    if (!tag) {
      i++
      continue
    }
    flush(i)
    i = tag.end
    textStart = i

    if (tag.name === 'br') {
      if (!tag.close) out().push({ type: 'br' })
      continue
    }
    if (!ALLOWED.has(tag.name)) continue
    const name = tag.name as SafeTag

    if (tag.close) {
      let k = stack.length - 1
      while (k >= 0 && stack[k].tag !== name) k--
      if (k >= 0) stack.length = k
      continue
    }
    if (stack.length >= MAX_DEPTH) continue
    const node: SafeElement = { type: 'el', tag: name, children: [] }
    if (name === 'a') {
      const href = hrefOf(tag.attrs)
      if (href) node.href = href
    }
    out().push(node)
    stack.push(node)
  }
  flush(s.length)
  return root
}
