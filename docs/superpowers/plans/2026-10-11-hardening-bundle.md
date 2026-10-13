# Hardening Bundle Implementation Plan

> **Status (2026-10-13):** executed inline on 2026-10-11, merged to main (head ec1eda5) and deployed the same day; the in-range dependency refresh (Task 8) shipped with the parser v6 release (47bae5d). The checkboxes below were not ticked as the work went on: the git log is the record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what is still open of `docs/superpowers/specs/2026-10-03-hardening-bundle-design.md` (a CSV export that can run formulas in a spreadsheet, a CSP that allows `eval` and a stray CDN, an unsanitized third-party HTML description, a CI that never builds the app plus no Dependabot, 27 packages behind their own version ranges) and fix two small things found since (two undocumented memory-guard variables; the start-up stage-table sweep giving up when ClickHouse is not accepting connections yet).

**Architecture:** Two pure, unit-tested helpers (`lib/csv-safe.ts`, `lib/safe-html.ts`) and one small component replace the two unsafe spots. `next.config.mjs`, CI, Dependabot and the compose file get small declarative edits that source-pin tests hold in place. The sweep retry is a loop inside `startStageSweeper`. It ships as two local deploys, each behind the full gate, the rehearsals and a rollback tag: first the code and config (Tasks 1-7), then the in-range dependency refresh on its own (Task 8), so a bad dependency can be rolled back without losing the hardening.

**Tech Stack:** Next.js 15 (App Router, `output: 'standalone'` in production), React 19, TypeScript strict, Vitest 4 (`environment: node`, alias `@` = repo root, tests live in `__tests__/` and are NOT type-checked by `tsc`), Docker Compose, GitHub Actions.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-10-03-hardening-bundle-design.md` (H1-H6). Numbers refreshed on 2026-10-11: the suite is 171 files / 2,518 tests; 27 packages are behind their own `package.json` range; `npm audit` reports 9 findings, all in the dev tool chain (`npm audit --omit=dev` = 0); 15 packages have a new major, which this plan does NOT touch.
- Already done by the disk-safety release (do not redo): CI `runs-on: ubuntu-24.04` with `actions/checkout@v7` and `actions/setup-node@v7`; `.claude/launch.json` tracked, `.claude/settings.local.json` ignored; `styles/globals.css` and `public/placeholder*` deleted; `npm audit fix` (next 15.5.27, sharp 0.35.5, source-map-js 1.2.2).
- No change to any data, any API response shape (except the CSV bytes in H1) or any ClickHouse object.
- The repository is PUBLIC: no real credentials, search terms, file names from the owner's data or personal data in tests, docs or commit messages. Fixtures are synthetic (`example.test`, `mail.test`).
- The production build strips `console.log` (`next.config.mjs` `removeConsole` keeps `error` and `warn`): a line that must show in `docker logs` uses `console.warn`.
- Deploys are local-only (standing permission): tag a rollback image first, recreate only the `app` service, and never while an import runs (`inbox/` and `inbox/processing/` empty, no `ulp.zz_import_*` table). Never run `docker system prune` or `docker image prune`: the daemon is shared with another project. Docker builds and compose commands use the scoped config `DOCKER_CONFIG=/tmp/claude-1000/dockercfg` (this laptop's global Docker config is broken).
- Work happens on a branch in the primary checkout (no worktree). Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tasks 1-6 are code and tests only and may run while the pile import is running. Tasks 7 and 8 build images, start the 6 GiB rehearsal stack and restart the app: they wait until the import is finished.
- Dependabot (Task 4) makes GitHub open up to 5 pull requests a week in the owner's public repository. The spec's default is yes; Step 6 of Task 4 asks the owner once before that file is pushed.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/csv-safe.ts` | create | `csvCell`: one quoted CSV cell, formula-safe |
| `app/api/export/route.ts` | modify | uses `csvCell`; reads `csv_guard` from the body |
| `lib/safe-html.ts` | create | `parseSafeHtml`: allow-list parser, returns a data tree, never a string of HTML |
| `components/safe-description.tsx` | create | renders the tree as React elements |
| `app/breaches/[name]/page.tsx` | modify | renders the description through `SafeDescription` |
| `next.config.mjs` | modify | `poweredByHeader: false`; CSP without `'unsafe-eval'` and without the CDN |
| `.github/workflows/ci.yml` | modify | + `npm run build` |
| `.github/dependabot.yml` | create | weekly grouped npm updates, monthly Actions updates |
| `docker-compose.yml`, `.env.example`, `README.md` | modify | forward and document the two memory-guard variables |
| `lib/ingest-stage.ts` | modify | `startStageSweeper` retries the first sweep |
| `__tests__/csv-safe.test.ts`, `__tests__/export-route-csv-guard.test.ts`, `__tests__/safe-html.test.ts`, `__tests__/safe-description-wiring.test.ts`, `__tests__/security-headers.test.ts`, `__tests__/memory-guard-env.test.ts` | create | the new tests |
| `__tests__/ci-workflow.test.ts`, `__tests__/ingest-stage.test.ts` | modify | extended |

---

### Task 1: CSV cell guard (H1)

**Files:**
- Create: `lib/csv-safe.ts`
- Create: `__tests__/csv-safe.test.ts`
- Create: `__tests__/export-route-csv-guard.test.ts`
- Modify: `app/api/export/route.ts` (imports; the body destructuring at about line 108; the `csv` branch at about lines 233-243)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `csvCell(value: unknown, guard?: boolean): string` (default `guard = true`), imported by the export route.

- [ ] **Step 0: Branch**

```bash
cd /home/cole/ulp-suite && git status --short && git switch -c hardening-bundle
```

Expected: `git status --short` prints nothing (clean), then `Switched to a new branch 'hardening-bundle'`.

- [ ] **Step 1: Write the failing unit test**

Create `__tests__/csv-safe.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { csvCell } from '@/lib/csv-safe'

describe('csvCell', () => {
  test('quotes a plain value', () => {
    expect(csvCell('abc')).toBe('"abc"')
  })

  test.each([
    ['=1+1', `"'=1+1"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\tx', `"'\tx"`],
    ['\rx', `"'\rx"`],
  ])('prefixes %j with a single quote', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  test('a numeric-looking negative value is guarded too', () => {
    expect(csvCell('-12345')).toBe(`"'-12345"`)
  })

  test('only the FIRST character decides: a leading space, or a trigger later in the value, is left alone', () => {
    expect(csvCell(' =1')).toBe('" =1"')
    expect(csvCell('a=1')).toBe('"a=1"')
    expect(csvCell('user@example.test')).toBe('"user@example.test"')
  })

  test('doubles embedded quotes, before or after the guard', () => {
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell('=a"b')).toBe(`"'=a""b"`)
  })

  test('keeps newlines and Unicode inside the quoted cell', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('é✓')).toBe('"é✓"')
  })

  test('empty, null and undefined are an empty cell', () => {
    expect(csvCell('')).toBe('""')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })

  test('numbers are stringified', () => {
    expect(csvCell(12)).toBe('"12"')
  })

  test('guard=false gives the old bytes', () => {
    expect(csvCell('=1+1', false)).toBe('"=1+1"')
    expect(csvCell('-12345', false)).toBe('"-12345"')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/csv-safe.test.ts 2>&1 | tail -15`
Expected: FAIL, `Failed to resolve import "@/lib/csv-safe"` (or "Cannot find module").

- [ ] **Step 3: Implement `lib/csv-safe.ts`**

```ts
/**
 * One quoted CSV cell for the export route.
 *
 * A spreadsheet treats a cell whose first character is = + - @ (or TAB or CR) as a formula, so a password such as
 * `=HYPERLINK("http://...","click")` in an exported file runs when the file is opened ("CSV injection", OWASP). csvCell puts a single
 * quote in front of such a value, which Excel, Sheets and LibreOffice show as plain text, then doubles embedded quotes and wraps the
 * cell in double quotes. Only the first character decides. `guard = false` returns the unguarded bytes for scripts that need them.
 */
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: unknown, guard = true): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (guard && FORMULA_START.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
```

- [ ] **Step 4: Run the unit test and watch it pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/csv-safe.test.ts 2>&1 | tail -8`
Expected: PASS, 14 tests (6 trigger rows + 8 others).

- [ ] **Step 5: Write the failing route test**

Create `__tests__/export-route-csv-guard.test.ts`:

```ts
import { vi, describe, test, expect, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ validateRequest: vi.fn().mockResolvedValue({ id: 1, role: 'admin' }) }))

let tableRows: Array<Record<string, string>> = []

vi.mock('@/lib/clickhouse', () => ({
  executeQuery: vi.fn(async (sql: string) => {
    if (/system\.projections/.test(sql)) return [{ defined: 1, parts: 1, with_projection: 1, covered_from: 1_786_000_000 }]
    return tableRows
  }),
  getClient: () => ({ query: async () => ({ stream: () => (async function* () {})() }) }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/export/route'
import { resetNewestFirstReadyCache } from '@/lib/newest-first'

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/export', { method: 'POST', body: JSON.stringify(body) }))

const row = (over: Record<string, string>) => ({
  url: 'https://a.example/login', email: 'u@mail.test', password: 'pw', domain: 'a.example', source_file: 'f.txt', breach_name: '',
  country_tier: '', login_type: 'email', password_length: '2', password_mask: 'alpha', url_scheme: 'https', is_corporate_email: '0',
  email_domain: 'mail.test', url_host: 'a.example', password_entropy_band: 'weak', imported_at: '2026-10-01 00:00:00', ...over,
})

beforeEach(() => {
  resetNewestFirstReadyCache()
})

describe('POST /api/export — CSV formula guard', () => {
  test('a cell that starts with = + - @ gets a leading quote; the other formats keep their bytes', async () => {
    tableRows = [row({ password: '=HYPERLINK("http://x.test","c")', email: '-12345', url: '@cmd' })]
    const csv = await (await post({ format: 'csv' })).text()
    const dataLine = csv.split('\n')[1]
    expect(dataLine).toContain(`"'=HYPERLINK(""http://x.test"",""c"")"`)
    expect(dataLine).toContain(`"'-12345"`)
    expect(dataLine).toContain(`"'@cmd"`)
    const ulp = await (await post({ format: 'ulp' })).text()
    expect(ulp).toBe('@cmd:-12345:=HYPERLINK("http://x.test","c")')
  })

  test('csv_guard:false gives the old bytes', async () => {
    tableRows = [row({ password: '=1+1' })]
    const dataLine = (await (await post({ format: 'csv', csv_guard: false })).text()).split('\n')[1]
    expect(dataLine).toContain('"=1+1"')
    expect(dataLine).not.toContain(`"'=1+1"`)
  })

  test('the header row is untouched', async () => {
    tableRows = [row({})]
    const csv = await (await post({ format: 'csv' })).text()
    expect(csv.split('\n')[0].startsWith('url,email,password,domain,source_file,breach_name')).toBe(true)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/export-route-csv-guard.test.ts 2>&1 | tail -20`
Expected: FAIL in the first test (`expected ... to contain "'=HYPERLINK...`); the other two pass already, which is fine: they pin behaviour that must not change.

- [ ] **Step 7: Change the route**

In `app/api/export/route.ts`:

1. After the line `import { noiseWhere } from "@/lib/ulp-noise"` add:

```ts
import { csvCell } from "@/lib/csv-safe"
```

2. In the POST body destructuring, after the line `    dedupe        = '',` add:

```ts
    csv_guard     = true,
```

3. In the `csv` branch, replace the line

```ts
      const csvEscape = (s: string) => `"${String(s).replace(/"/g, '""')}"`
```

with

```ts
      const guard = csv_guard !== false
```

and replace the line

```ts
        ].map(csvEscape).join(',')).join('\n')
```

with

```ts
        ].map(value => csvCell(value, guard)).join(',')).join('\n')
```

- [ ] **Step 8: Run the new tests and the existing export tests**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/csv-safe.test.ts __tests__/export-route-csv-guard.test.ts __tests__/export-route.test.ts __tests__/export-route-imported-range.test.ts 2>&1 | tail -10`
Expected: PASS, 4 files, 0 failures. Then `npx tsc --noEmit` exits 0.

- [ ] **Step 9: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/csv-safe.ts app/api/export/route.ts __tests__/csv-safe.test.ts __tests__/export-route-csv-guard.test.ts && git commit -m "fix(export): a CSV cell that starts with = + - @ can no longer run as a spreadsheet formula" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Safe description rendering (H3)

**Files:**
- Create: `lib/safe-html.ts`
- Create: `components/safe-description.tsx`
- Create: `__tests__/safe-html.test.ts`
- Create: `__tests__/safe-description-wiring.test.ts`
- Modify: `app/breaches/[name]/page.tsx` (one import; the `dangerouslySetInnerHTML` paragraph at about lines 245-249)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseSafeHtml(input: string): SafeNode[]`, the types `SafeNode` and `SafeTag`, the constants `MAX_INPUT_CHARS = 20_000` and `MAX_DEPTH = 20` (all from `lib/safe-html.ts`), and `<SafeDescription html={string} className?={string} />` (from `components/safe-description.tsx`).

- [ ] **Step 1: Write the failing parser test**

Create `__tests__/safe-html.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/safe-html.test.ts 2>&1 | tail -12`
Expected: FAIL, `Failed to resolve import "@/lib/safe-html"`.

- [ ] **Step 3: Implement `lib/safe-html.ts`**

```ts
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
```

- [ ] **Step 4: Run the parser test and watch it pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/safe-html.test.ts 2>&1 | tail -8`
Expected: PASS, 23 tests (8 "kept", 11 "removed" counting each `test.each` row, 4 "bounds"), 0 failures. If a case fails, fix the parser, not the test: the cases are the contract.

- [ ] **Step 5: Create the component**

Create `components/safe-description.tsx`:

```tsx
import { Fragment, type ReactNode } from 'react'
import { parseSafeHtml, type SafeNode } from '@/lib/safe-html'

function render(nodes: SafeNode[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`
    if (node.type === 'text') return <Fragment key={key}>{node.text}</Fragment>
    if (node.type === 'br') return <br key={key} />
    const children = render(node.children, `${key}.`)
    switch (node.tag) {
      case 'a':
        return node.href ? (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {children}
          </a>
        ) : (
          <span key={key}>{children}</span>
        )
      case 'b':
      case 'strong':
        return <strong key={key}>{children}</strong>
      case 'i':
      case 'em':
        return <em key={key}>{children}</em>
      case 'p':
        // A block span, not a <p>: this component is already inside a paragraph-sized container and <p> must not nest.
        return <span key={key} className="block mb-2">{children}</span>
    }
  })
}

/** A third-party description (HTML from the HIBP sync or the breach editor) shown as text and a few safe elements. Never innerHTML. */
export function SafeDescription({ html, className }: { html: string; className?: string }) {
  return <div className={className}>{render(parseSafeHtml(html))}</div>
}
```

- [ ] **Step 6: Write the failing wiring test**

Create `__tests__/safe-description-wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const page = readFileSync(new URL('../app/breaches/[name]/page.tsx', import.meta.url), 'utf8')
const component = readFileSync(new URL('../components/safe-description.tsx', import.meta.url), 'utf8')

describe('breach page', () => {
  test('shows the description through SafeDescription, never as raw HTML', () => {
    expect(page).toContain('<SafeDescription html={breach.description}')
    expect(page).toContain('import { SafeDescription } from "@/components/safe-description"')
    expect(page).not.toContain('dangerouslySetInnerHTML')
  })

  test('the component builds React elements from the parsed tree and never assigns a string of HTML', () => {
    expect(component).toContain('parseSafeHtml')
    expect(component).not.toContain('dangerouslySetInnerHTML')
    expect(component).toContain('rel="noopener noreferrer"')
  })
})
```

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/safe-description-wiring.test.ts 2>&1 | tail -10`
Expected: FAIL on the first test (the page still has `dangerouslySetInnerHTML`).

- [ ] **Step 7: Change the page**

In `app/breaches/[name]/page.tsx`:

1. After the line `import { localInputToUtcIso, utcIsoToDisplay } from "@/lib/imported-range-client"` add:

```tsx
import { SafeDescription } from "@/components/safe-description"
```

2. Replace

```tsx
                <p
                  className="text-sm leading-relaxed text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: breach.description }}
                />
```

with

```tsx
                <SafeDescription html={breach.description} className="text-sm leading-relaxed text-muted-foreground" />
```

- [ ] **Step 8: Run the tests, typecheck and lint the changed files**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/safe-html.test.ts __tests__/safe-description-wiring.test.ts 2>&1 | tail -8 && npx tsc --noEmit && echo TSC-OK`
Expected: PASS, then `TSC-OK`.

- [ ] **Step 9: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/safe-html.ts components/safe-description.tsx "app/breaches/[name]/page.tsx" __tests__/safe-html.test.ts __tests__/safe-description-wiring.test.ts && git commit -m "fix(breaches): show a breach description as text and a few safe elements, never as raw HTML" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Response headers (H2)

**Files:**
- Modify: `next.config.mjs` (the `nextConfig` object and the `Content-Security-Policy` entry)
- Create: `__tests__/security-headers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no `X-Powered-By` header; a CSP whose `script-src` is `'self' 'unsafe-inline'` and whose `connect-src` is `'self'`. Task 7 proves in a real browser that no page needs what was removed.

- [ ] **Step 1: Write the failing test**

Create `__tests__/security-headers.test.ts`:

```ts
import { describe, expect, test } from 'vitest'

async function load() {
  const mod = await import('../next.config.mjs')
  const config = mod.default as { poweredByHeader?: boolean; headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> }
  const rules = await config.headers()
  const headers = Object.fromEntries(rules[0].headers.map(h => [h.key, h.value]))
  return { config, headers }
}

describe('security headers', () => {
  test('the server does not announce its framework', async () => {
    expect((await load()).config.poweredByHeader).toBe(false)
  })

  test('the CSP has no eval and no CDN, and keeps the rest', async () => {
    const csp = (await load()).headers['Content-Security-Policy']
    const directive = (name: string) => csp.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `)) ?? ''
    expect(directive('script-src')).toBe("script-src 'self' 'unsafe-inline'")
    expect(directive('connect-src')).toBe("connect-src 'self'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('jsdelivr')
    expect(directive('default-src')).toBe("default-src 'self'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
  })

  test('the other headers are still sent', async () => {
    const { headers } = await load()
    for (const key of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security', 'Permissions-Policy']) {
      expect(headers[key], key).toBeTruthy()
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/security-headers.test.ts 2>&1 | tail -15`
Expected: FAIL in the first two tests (`poweredByHeader` is `undefined`; the `script-src` still has `'unsafe-eval'`), the third passes.

- [ ] **Step 3: Change `next.config.mjs`**

1. Directly after the line `const nextConfig = {` add:

```js
  // Do not announce the framework in an `X-Powered-By: Next.js` header.
  poweredByHeader: false,
```

2. Replace the CSP value line

```js
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'none';",
```

with

```js
            // 'unsafe-inline' stays: Next injects inline bootstrap scripts, and a nonce-based policy needs dynamic rendering for every page
            // (a separate project). 'unsafe-eval' and the CDN are gone: a production build needs neither (checked page by page in a real browser).
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';",
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/security-headers.test.ts 2>&1 | tail -8`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd /home/cole/ulp-suite && git add next.config.mjs __tests__/security-headers.test.ts && git commit -m "fix(headers): no X-Powered-By, and a CSP without eval or the stray CDN" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

If Task 7's browser pass shows a page that needs `eval`, this task is partly reverted there (see Task 7, Step 8).

---

### Task 4: CI builds the app, and Dependabot (H4)

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Modify: `__tests__/ci-workflow.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a CI step `npm run build` after lint; `.github/dependabot.yml`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/ci-workflow.test.ts` (after the existing `describe('CI workflow', ...)` block):

```ts
describe('CI workflow — build', () => {
  test('builds the app after lint: a build failure is caught here, not in the next Docker build', () => {
    expect(ci).toMatch(/- run: npm run build\n\s+env:\n\s+NEXT_TELEMETRY_DISABLED: '1'/)
    expect(ci.indexOf('npm run build')).toBeGreaterThan(ci.indexOf('npm run lint'))
  })
})

const dependabot = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')

describe('Dependabot', () => {
  test('npm weekly, minor and patch grouped into one pull request, at most 5 open', () => {
    expect(dependabot).toContain('package-ecosystem: npm')
    expect(dependabot).toContain('interval: weekly')
    expect(dependabot).toContain('open-pull-requests-limit: 5')
    expect(dependabot).toMatch(/minor-and-patch:\s+update-types:\s+- minor\s+- patch/)
  })

  test('major versions of the framework packages stay an owner decision', () => {
    const names = [
      'next', 'react', 'react-dom', 'tailwindcss', 'eslint', 'eslint-config-next', 'zod', 'typescript', 'vitest', 'better-sqlite3',
      '@types/node', '@types/react', '@types/react-dom', '@types/better-sqlite3',
    ]
    for (const name of names) {
      const escaped = name.replace(/[/@]/g, m => `\\${m}`)
      expect(dependabot, name).toMatch(new RegExp(`dependency-name: "${escaped}"\\s+update-types: \\["version-update:semver-major"\\]`))
    }
  })

  test('GitHub Actions are checked monthly', () => {
    expect(dependabot).toMatch(/package-ecosystem: github-actions[\s\S]*interval: monthly/)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ci-workflow.test.ts 2>&1 | tail -15`
Expected: FAIL (`ENOENT ... dependabot.yml` at import time fails the whole file).

- [ ] **Step 3: Add the build step to CI**

In `.github/workflows/ci.yml`, after the line `      - run: npm run lint` add:

```yaml
      - run: npm run build
        env:
          NEXT_TELEMETRY_DISABLED: '1'
```

- [ ] **Step 4: Create `.github/dependabot.yml`**

```yaml
# Dependency update pull requests. Minor and patch updates arrive as ONE grouped pull request a week; a new MAJOR version of the
# framework packages is an owner decision (see docs/superpowers/specs/2026-10-03-hardening-bundle-design.md, "Deliberately NOT done"),
# so those are ignored here. Repository-level Dependabot alerts and security updates are separate switches in the GitHub settings.
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
    ignore:
      - dependency-name: "next"
        update-types: ["version-update:semver-major"]
      - dependency-name: "eslint-config-next"
        update-types: ["version-update:semver-major"]
      - dependency-name: "react"
        update-types: ["version-update:semver-major"]
      - dependency-name: "react-dom"
        update-types: ["version-update:semver-major"]
      - dependency-name: "tailwindcss"
        update-types: ["version-update:semver-major"]
      - dependency-name: "eslint"
        update-types: ["version-update:semver-major"]
      - dependency-name: "zod"
        update-types: ["version-update:semver-major"]
      - dependency-name: "typescript"
        update-types: ["version-update:semver-major"]
      - dependency-name: "vitest"
        update-types: ["version-update:semver-major"]
      - dependency-name: "better-sqlite3"
        update-types: ["version-update:semver-major"]
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
      - dependency-name: "@types/react"
        update-types: ["version-update:semver-major"]
      - dependency-name: "@types/react-dom"
        update-types: ["version-update:semver-major"]
      - dependency-name: "@types/better-sqlite3"
        update-types: ["version-update:semver-major"]
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: monthly
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ci-workflow.test.ts 2>&1 | tail -10`
Expected: PASS, 6 tests (2 existing, 1 build, 3 Dependabot), 0 failures.

- [ ] **Step 6: Ask the owner once, then commit**

STOP and ask the owner: "Dependabot version updates make GitHub open up to 5 pull requests a week in your public repository (minor/patch grouped into one, majors of the framework packages ignored). Keep `.github/dependabot.yml`? (Default: yes.)" If the answer is no, delete `.github/dependabot.yml` and the `describe('Dependabot', ...)` block from the test, and keep only the build step.

```bash
cd /home/cole/ulp-suite && git add .github/workflows/ci.yml .github/dependabot.yml __tests__/ci-workflow.test.ts && git commit -m "ci: build the app in CI, and propose dependency updates with Dependabot" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The memory-guard variables are forwarded and documented (H6)

**Files:**
- Modify: `docker-compose.yml` (the `app` service `environment:` block, after `INGEST_NOVELTY_SLAB_ROWS`)
- Modify: `.env.example` (after `# INGEST_NOVELTY_SLAB_ROWS=20000000`)
- Modify: `README.md` (after the `INGEST_NOVELTY_SLAB_ROWS` bullet)
- Create: `__tests__/memory-guard-env.test.ts`

**Interfaces:**
- Consumes: the defaults in `lib/clickhouse-memory-guard.ts` (`MEMORY_GUARD_THRESHOLD_RATIO` 0.75, `MEMORY_GUARD_MAX_WAIT_MS` 600000; an empty value falls back to the default).
- Produces: both variables can be set from `.env`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/memory-guard-env.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const NAMES = ['MEMORY_GUARD_THRESHOLD_RATIO', 'MEMORY_GUARD_MAX_WAIT_MS']

describe('memory guard variables', () => {
  for (const name of NAMES) {
    test(`${name} is forwarded by the production compose file, shown in .env.example and described in the README`, () => {
      expect(read('docker-compose.yml')).toContain(`${name}: \${${name}:-}`)
      expect(read('.env.example')).toContain(`# ${name}=`)
      expect(read('README.md')).toContain('`' + name + '`')
    })
  }

  test('the defaults the docs state are the ones in the code', () => {
    const code = read('lib/clickhouse-memory-guard.ts')
    expect(code).toContain('process.env.MEMORY_GUARD_THRESHOLD_RATIO, 0.75')
    expect(code).toContain('process.env.MEMORY_GUARD_MAX_WAIT_MS, 10 * 60 * 1_000')
    expect(read('.env.example')).toContain('# MEMORY_GUARD_THRESHOLD_RATIO=0.75')
    expect(read('.env.example')).toContain('# MEMORY_GUARD_MAX_WAIT_MS=600000')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/memory-guard-env.test.ts 2>&1 | tail -12`
Expected: FAIL (3 tests: the compose, .env.example and README checks).

- [ ] **Step 3: Forward the variables in `docker-compose.yml`**

After the line `      INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}` add:

```yaml
      # Memory guard (lib/clickhouse-memory-guard.ts) -- optional. An import waits before its next batch while ClickHouse's own memory
      # tracker is at or above MEMORY_GUARD_THRESHOLD_RATIO of its ceiling (empty = 0.75), and goes ahead anyway once it has waited
      # MEMORY_GUARD_MAX_WAIT_MS (empty = 600000, ten minutes).
      MEMORY_GUARD_THRESHOLD_RATIO: ${MEMORY_GUARD_THRESHOLD_RATIO:-}
      MEMORY_GUARD_MAX_WAIT_MS: ${MEMORY_GUARD_MAX_WAIT_MS:-}
```

- [ ] **Step 4: Document them in `.env.example`**

After the line `# INGEST_NOVELTY_SLAB_ROWS=20000000` add:

```
# ── Memory guard ─────────────────────────────────────────────────────────────
# Before each batch an import checks ClickHouse's own memory tracker and waits while it is at or above MEMORY_GUARD_THRESHOLD_RATIO of
# its ceiling (default 0.75, a ratio between 0 and 1). After MEMORY_GUARD_MAX_WAIT_MS (default 600000 = ten minutes) it goes ahead anyway,
# and so it does if the check itself fails: the guard paces imports, it never blocks one for good.
# MEMORY_GUARD_THRESHOLD_RATIO=0.75
# MEMORY_GUARD_MAX_WAIT_MS=600000
```

- [ ] **Step 5: Document them in `README.md`**

After the line `  this are committed in one step; larger ones in hash slabs, one slab at a time across all imports.` add:

```
- `MEMORY_GUARD_THRESHOLD_RATIO` — an import waits before its next batch while ClickHouse's own memory
  tracker is at or above this share of its ceiling (default `0.75`).
- `MEMORY_GUARD_MAX_WAIT_MS` — how long it waits before going ahead anyway (default `600000`, ten
  minutes). The guard paces imports; it never blocks one for good.
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/memory-guard-env.test.ts __tests__/novelty-wiring.test.ts 2>&1 | tail -10`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
cd /home/cole/ulp-suite && git add docker-compose.yml .env.example README.md __tests__/memory-guard-env.test.ts && git commit -m "docs(config): forward and document the two memory-guard variables" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The start-up stage sweep retries (found live on 2026-10-11)

After a reboot the app container starts a few seconds before ClickHouse accepts connections: the first query got `ECONNREFUSED` and the start-up sweep of leftover `zz_import_*` tables logged "failed" and did nothing until the hourly sweep.

**Files:**
- Modify: `lib/ingest-stage.ts` (`startStageSweeper`, at about lines 165-181)
- Modify: `__tests__/ingest-stage.test.ts` (the `startStageSweeper` describe, at about lines 121-148)

**Interfaces:**
- Consumes: `sweepOrphanStages` (same file).
- Produces: `startStageSweeper(opts?: { intervalMs?: number; attempts?: number; retryDelayMs?: number }): Promise<void>`. Defaults: 6 attempts, 3000 ms apart (15 s, inside the 20 s start-up budget that `instrumentation.ts` gives it), still never rejects.

- [ ] **Step 1: Update and extend the tests**

In `__tests__/ingest-stage.test.ts`, inside `describe('startStageSweeper', ...)`, replace the test `'reports what it dropped, and never rejects when ClickHouse is down'` with these two tests:

```ts
  it('retries the first sweep until ClickHouse answers (the app can start before ClickHouse accepts connections)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.query
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 172.19.0.2:8123'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 172.19.0.2:8123'))
      .mockResolvedValue({ json: async () => [] })
    try {
      await startStageSweeper({ intervalMs: 3_600_000, retryDelayMs: 1 })
      expect(h.query).toHaveBeenCalledTimes(3)
      expect(warn).toHaveBeenCalledWith('[ingest-stage] start-up sweep: no orphan stage tables')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphan sweep failed: connect ECONNREFUSED'))
    } finally {
      clearInterval(globalThis.__ulpStageSweeper)
      globalThis.__ulpStageSweeper = undefined
    }
  })

  it('gives up after the configured attempts, says so, and never rejects when ClickHouse stays down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.query.mockRejectedValue(new Error('connection refused'))
    try {
      await expect(startStageSweeper({ intervalMs: 3_600_000, attempts: 3, retryDelayMs: 1 })).resolves.toBeUndefined()
      expect(h.query).toHaveBeenCalledTimes(3)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphan sweep failed: connection refused'))
    } finally {
      clearInterval(globalThis.__ulpStageSweeper)
      globalThis.__ulpStageSweeper = undefined
    }
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-stage.test.ts 2>&1 | tail -15`
Expected: FAIL (the first new test: `h.query` called 1 time, not 3; the second: 1 call, not 3).

- [ ] **Step 3: Implement the retry**

In `lib/ingest-stage.ts`, replace the whole `startStageSweeper` function (the doc comment above it stays, with its first sentence extended as below) with:

```ts
/**
 * Sweeps once now (nothing a previous process started can still be running) and then hourly, leaving anything younger than 30
 * minutes alone. The first sweep is retried when it fails: after a reboot this process can start a few seconds before ClickHouse
 * accepts connections (2026-10-11: ECONNREFUSED on the first query), so by default it tries 6 times, 3 s apart, which stays inside the
 * 20 s start-up budget instrumentation.ts gives it. The returned promise settles when the first sweep succeeded or the attempts ran
 * out, so that start-up can wait for it before the inbox watcher begins; it never rejects.
 */
export async function startStageSweeper(opts: { intervalMs?: number; attempts?: number; retryDelayMs?: number } = {}): Promise<void> {
  if (globalThis.__ulpStageSweeper) return
  // console.warn, not console.log: the production build strips console.log (next.config removeConsole keeps error and warn).
  const run = async (minAgeSeconds: number, announce: boolean): Promise<boolean> => {
    try {
      const dropped = await sweepOrphanStages({ minAgeSeconds })
      if (dropped.length > 0) console.warn(`[ingest-stage] dropped ${dropped.length} orphan stage table(s): ${dropped.join(', ')}`)
      else if (announce) console.warn('[ingest-stage] start-up sweep: no orphan stage tables')
      return true
    } catch (err) {
      console.warn(`[ingest-stage] orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  const timer = setInterval(() => void run(SWEEP_AFTER_MS / 1000, false), opts.intervalMs ?? 60 * 60_000)
  timer.unref?.()
  globalThis.__ulpStageSweeper = timer

  const attempts = Math.max(1, Math.floor(opts.attempts ?? 6))
  const retryDelayMs = opts.retryDelayMs ?? 3_000
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await run(0, true)) return
    if (attempt < attempts) await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs))
  }
}
```

Keep the `declare global { var __ulpStageSweeper ... }` block above it untouched.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd /home/cole/ulp-suite && npx vitest run __tests__/ingest-stage.test.ts __tests__/novelty-wiring.test.ts 2>&1 | tail -10 && npx tsc --noEmit && echo TSC-OK`
Expected: PASS, 0 failures, `TSC-OK`.

- [ ] **Step 5: Commit**

```bash
cd /home/cole/ulp-suite && git add lib/ingest-stage.ts __tests__/ingest-stage.test.ts && git commit -m "fix(ingest): retry the start-up stage sweep while ClickHouse is not accepting connections yet" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Gate, rehearsals, a real-browser CSP pass, merge and deploy (code and config)

Do not start this task while the pile import is running: it builds an image, starts a 6 GiB rehearsal stack and restarts `app`.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-hardening-bundle-design.md` (status line)

**Interfaces:**
- Consumes: Tasks 1-6 on branch `hardening-bundle`.
- Produces: `main` and the running `ulpsuite_app` carry the hardening; a rollback tag exists.

- [ ] **Step 1: Precondition: nothing is importing**

Run:

```bash
cd /home/cole/ulp-suite && echo "inbox:" && ls -A inbox | grep -v -E '^(done|failed|processing)$'; echo "processing:" && ls -A inbox/processing; echo "stage tables:" && docker exec ulpsuite_clickhouse clickhouse-client -q "SELECT count() FROM system.tables WHERE database = 'ulp' AND name LIKE 'zz%'"; pgrep -af 'feeder.sh' | grep -v pgrep || echo "no feeder running"
```

Expected: both listings empty, `0`, `no feeder running`. If not, wait; do not continue.

- [ ] **Step 2: The full gate**

Run each and read the tail:

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && echo TSC-OK
cd /home/cole/ulp-suite && npm test 2>&1 | tail -8
cd /home/cole/ulp-suite && npm run lint 2>&1 | tail -6
cd /home/cole/ulp-suite && NEXT_TELEMETRY_DISABLED=1 npm run build 2>&1 | tail -12
```

Expected: `TSC-OK`; vitest `Test Files  177 passed` and `0 failed` (the baseline was 171 files / 2,518 tests; this plan adds 6 test files and extends 2); lint "No ESLint warnings or errors"; the build ends with the route table and exit 0. Any failure: fix it before going on.

- [ ] **Step 3: Tag the RUNNING image as the rollback, THEN build the new one**

The order matters (found the hard way on 2026-10-11): with Docker's containerd image store, moving `:latest` to the new build garbage-collects the old, now untagged image, even though its container keeps running, and the rollback target is gone for good. Tag first.

```bash
cd /home/cole/ulp-suite && TAG=ulp-suite-app:rollback-$(date -u +%Y%m%d-%H%Mz) && docker tag "$(docker inspect -f '{{.Image}}' ulpsuite_app)" "$TAG" && echo "rollback tag: $TAG -> $(docker image inspect $TAG --format '{{.Id}}' | cut -c8-19)"
mkdir -p /tmp/claude-1000/dockercfg && echo '{}' > /tmp/claude-1000/dockercfg/config.json
cd /home/cole/ulp-suite && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose build app 2>&1 | tail -15
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' | grep '^ulp-suite-app:'
```

Expected: the tag line names the id the container runs; the build ends with `naming to docker.io/library/ulp-suite-app:latest`; both the new `:latest` ("seconds ago") and the rollback tag are listed. WARNING: `:latest` now points at the new, undeployed image; if the session dies here, a plain `docker compose up` of `app` would deploy it. If the rollback image was lost anyway, rebuild it from the deployed commit: `git archive <commit> | DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker build -t ulp-suite-app:rollback-<commit> -`.

- [ ] **Step 4: Rehearsals on that image**

Run one after another, reading each tail (each prints one line per check and ends with a pass count; exit 0 when all pass):

```bash
cd /home/cole/ulp-suite && npx tsx scripts/e2e-alert-rehearsal.ts --keep 2>&1 | tail -45
cd /home/cole/ulp-suite && npx tsx scripts/e2e-upload-resilience.ts 2>&1 | tail -45
cd /home/cole/ulp-suite && npx tsx scripts/e2e-disk-gate.ts 2>&1 | tail -45
cd /home/cole/ulp-suite && npx tsx scripts/e2e-novelty-ingest.ts 2>&1 | tail -45
```

Expected: alert 36/36, upload-resilience 33/33, disk-gate 20/20, novelty 84/84. The `--keep` run leaves the throwaway stack up on `127.0.0.1:3101` for Step 5; the others use it.

- [ ] **Step 5: Real-browser pass for the CSP (H2) and the description renderer (H3)**

On the kept rehearsal stack (throwaway test data, local host `rehearsal.localhost:3101`, test admin `admin@rehearsal.test`; its password is in the stack's app container: `docker exec $(docker ps --filter name=rehearsal --filter name=app --format '{{.Names}}' | head -1) printenv ADMIN_PASSWORD`). Use the built-in browser (`mcp__Claude_Browser__*`), log in at `http://rehearsal.localhost:3101/login`, then open each of these pages and, after each, call `read_console_messages` with `pattern: "Content Security Policy|Refused to|violat"`:

`/credentials`, `/domains`, `/sources`, `/breaches`, `/breaches/new`, `/upload`, `/inbox`, `/lookup`, `/check`, `/monitoring`, `/saved-searches`, `/api-keys`, `/audit-logs`, `/users`, `/user-settings`, `/settings`, `/docs`.

Also: create a breach whose description is `<b>bold</b> <a href="https://example.test">link</a> <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 1">` (the breach form or `POST /api/breaches` with the admin cookie), open `/breaches/<name>`, and check with `javascript_tool` that `window.__pwned` is `undefined`, that the page shows "bold" in bold and a working link with `rel="noopener noreferrer"`, and that the script text appears as plain text.

Expected: no CSP message on any page; `window.__pwned` undefined. A CSP message that names `eval` or `script-src` on some page: note the page and go to Step 8.

- [ ] **Step 6: Merge, push, CI**

Tear the rehearsal stack down first (the compose file wants these variables even to stop the stack):

```bash
cd /home/cole/ulp-suite && REHEARSAL_JWT_SECRET=x REHEARSAL_ADMIN_EMAIL=x@x.test REHEARSAL_ADMIN_PASSWORD=x REHEARSAL_WEBHOOK_SECRET=x DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose -f docker-compose.rehearsal.yml -p ulp-rehearsal down -v 2>&1 | tail -5
```

Then update the spec's status line (first line starting with `Status:` in `docs/superpowers/specs/2026-10-03-hardening-bundle-design.md`) to: `Status: **implemented on <date> (plan docs/superpowers/plans/2026-10-11-hardening-bundle.md; H5 follows as its own deploy).**`, commit it, and:

```bash
cd /home/cole/ulp-suite && git switch main && git merge --ff-only hardening-bundle && git push origin main && gh run list --limit 1
```

Expected: fast-forward, push accepted. Watch the CI run to success (`gh run watch <id> --exit-status`); it now includes the build step.

- [ ] **Step 7: Deploy, verify**

```bash
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^ulp-suite-app:rollback' | head -2   # the rollback tag from Step 3 must be listed
cd /home/cole/ulp-suite && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose up -d --no-deps app 2>&1 | tail -4
until [ "$(docker inspect -f '{{.State.Health.Status}}' ulpsuite_app)" = healthy ]; do sleep 2; done; echo healthy
curl -sI http://127.0.0.1:3000/login | grep -i -E '^(x-powered-by|content-security-policy)' || true
docker logs --since 2m ulpsuite_app 2>&1 | grep -i -E 'error|warn' | grep -v 'monitor-rescan' | head -5
```

Expected: the rollback tag line; `healthy`; the curl prints only the new `content-security-policy:` line (script-src `'self' 'unsafe-inline'`) and NO `x-powered-by`; the log grep prints at most the start-up sweep line (`start-up sweep: no orphan stage tables`) and the disk-watch line; no error. Roll back with `docker tag <TAG> ulp-suite-app:latest && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose up -d --no-deps app`.

- [ ] **Step 8 (only if Step 5 found a page that needs eval): keep `'unsafe-eval'`**

Revert only that part: restore `'unsafe-eval'` in `script-src` in `next.config.mjs`, change the `script-src` expectation in `__tests__/security-headers.test.ts` to `"script-src 'self' 'unsafe-inline' 'unsafe-eval'"`, drop its `not.toContain('unsafe-eval')` line, add one sentence to the spec's "Decisions for the owner" saying which page needs it and that the finding is accepted, rebuild and repeat Steps 2-7.

---

### Task 8: In-range dependency refresh (H5), its own deploy

Do not start this task while the pile import is running. It starts after Task 7 is deployed and green.

**Files:**
- Modify: `package.json`, `package-lock.json` (whatever `npm update` changes inside the existing ranges)

**Interfaces:**
- Consumes: `main` at the Task 7 commit.
- Produces: no package behind its own range; the full gate, the four rehearsals and the live container green on the new lockfile; a rollback tag.

- [ ] **Step 1: Branch and record the starting point**

```bash
cd /home/cole/ulp-suite && git switch main && git pull --ff-only && git switch -c hardening-deps
npm outdated --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");const k=Object.keys(j);console.log("outdated="+k.length+" behindOwnRange="+k.filter(n=>j[n].wanted!==j[n].current).length)})'
```

Expected: about `outdated=40 behindOwnRange=27` (the 2026-10-11 numbers).

- [ ] **Step 2: Update inside the ranges and reinstall from the lockfile**

```bash
cd /home/cole/ulp-suite && npm update 2>&1 | tail -5
cd /home/cole/ulp-suite && git diff --stat package.json package-lock.json | tail -3
cd /home/cole/ulp-suite && git diff package.json | grep -E '^[-+] ' | head -40
rm -rf node_modules && npm ci 2>&1 | tail -4
```

Expected: `package.json` changes only lower bounds inside the same major (`^15.5.18` -> `^15.5.27`); NO major jump (if one shows, `git checkout package.json package-lock.json` and update that package by hand to its last in-range version). `npm ci` finishes without error.

- [ ] **Step 3: Prove the install is what the lockfile says (a silent `npm` failure fooled an earlier session)**

```bash
cd /home/cole/ulp-suite && node -e '
const lock = require("./package-lock.json"), pkg = require("./package.json");
const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
let bad = 0;
for (const n of names) {
  const want = lock.packages["node_modules/" + n]?.version;
  const have = JSON.parse(require("fs").readFileSync("node_modules/" + n + "/package.json", "utf8")).version;
  if (want !== have) { bad++; console.log("MISMATCH", n, "lock", want, "installed", have) }
}
console.log(bad === 0 ? "install matches the lockfile (" + names.length + " packages)" : bad + " mismatches");
process.exit(bad ? 1 : 0)'
npm outdated --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");const k=Object.keys(j);console.log("outdated="+k.length+" behindOwnRange="+k.filter(n=>j[n].wanted!==j[n].current).length)})'
npm audit --omit=dev 2>&1 | tail -3
```

Expected: `install matches the lockfile (N packages)`; `behindOwnRange=0`; `found 0 vulnerabilities` for production dependencies.

- [ ] **Step 4: The full gate**

```bash
cd /home/cole/ulp-suite && npx tsc --noEmit && echo TSC-OK
cd /home/cole/ulp-suite && npm test 2>&1 | tail -8
cd /home/cole/ulp-suite && npm run lint 2>&1 | tail -6
cd /home/cole/ulp-suite && NEXT_TELEMETRY_DISABLED=1 npm run build 2>&1 | tail -12
```

Expected: all green. A failure after the update points at one package: bisect by `git checkout package.json package-lock.json`, update half the list (`npm update <names>`), and repeat. `better-sqlite3` is a native addon: the Docker build compiles it from source; the rehearsals' SQLite-backed paths cover it.

- [ ] **Step 5: Commit and push the branch, wait for CI**

```bash
cd /home/cole/ulp-suite && git add package.json package-lock.json && git commit -m "chore(deps): refresh every dependency inside its own version range" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git push -u origin hardening-deps && gh run list --limit 1
```

Expected: the CI run on the branch is green (`gh run watch <id> --exit-status`).

- [ ] **Step 6: Image, rehearsals, deploy**

Repeat Task 7 Steps 1, 3 and 4 (precondition, image build, the four rehearsals; the CSP page walk is not needed again), then merge and deploy:

```bash
cd /home/cole/ulp-suite && git switch main && git merge --ff-only hardening-deps && git push origin main && git push origin --delete hardening-deps && git branch -d hardening-deps
```

then Task 7 Step 7 (rollback tag, `up -d --no-deps app`, healthy, no error in the log), and finally `docker exec ulpsuite_app node -e "console.log(require('next/package.json').version)"`, which must equal the version in `package-lock.json`.

- [ ] **Step 7: Close the loop**

Update `README.md`/the spec only where a number they state changed (dependency counts); record the two deploys, the rollback tags and the gate numbers in the project memory ledger (`project_open_items_2026_09_30.md`); remove the `hardening-bundle` branch if it is still there (`git branch -d hardening-bundle`).

---

## Self-review (run when the plan was written, 2026-10-11)

1. **Spec coverage.** H1 Task 1; H2 Task 3 (+ the browser proof in Task 7 Step 5 and the fallback in Step 8); H3 Task 2; H4 Task 4 (the Actions pin and bump were done by the disk-safety release; the build step and Dependabot are here); H5 Task 8; H6 Task 5 (the rest of H6 was done by the disk-safety release). Decisions 1-3 of the spec: 1 and 3 are the defaults in Tasks 1 and 3; 2 is asked in Task 4 Step 6. Added since the spec: Task 6 (sweep retry) and the `text_log` TTL stays deliberately out (the spec's "Deliberately NOT done").
2. **Placeholders.** None: every code step shows the code, every command its expected result. The only value read at run time is the date in the spec's status line and the rollback tag (`$(date ...)`).
3. **Names.** `csvCell(value, guard)` (Task 1) is the only name used by the route; `parseSafeHtml`, `SafeNode`, `SafeTag`, `MAX_INPUT_CHARS`, `MAX_DEPTH` (Task 2) are used by the component and the tests with the same spelling; `startStageSweeper` options `attempts` and `retryDelayMs` (Task 6) match between the tests and the code; the compose/README/.env names in Task 5 match `lib/clickhouse-memory-guard.ts`.
