import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect, vi } from 'vitest'
import { COLS, SiteRow, SiteRowBody, fmt } from '@/components/site-count-row'
import { STATUS_STYLE } from '@/components/site-mark-cell'
import type { SiteCount } from '@/lib/site-counts-input'
import type { SiteMark } from '@/lib/site-marks-input'

const counted = (over: Partial<SiteCount> = {}): SiteCount => ({
  host: 'corp.example', found: true, count: 30, host_count: 20, subdomain_count: 10, subdomains: 2,
  top_subdomains: [{ domain: 'app.corp.example', count: 10 }], ...over,
})
const notASite: SiteCount = {
  host: '', found: false, count: null, host_count: null, subdomain_count: null, subdomains: null, top_subdomains: [], error: 'not a site address',
}
const mark = (status: SiteMark['status'], note: string | null = null): SiteMark => ({ status, note, updated_by: 'a@example.test', updated_at: '2026-10-29 10:00:00' })
const noRows = () => counted({ count: 0, found: false, host_count: 0, subdomain_count: 0, subdomains: 0, top_subdomains: [] })

const row = (props: Partial<ComponentProps<typeof SiteRow>> & { result?: SiteCount; site?: string } = {}) => {
  const { result = counted(), site = 'https://www.corp.example/login', ...rest } = props
  return renderToStaticMarkup(createElement(SiteRow, { row: { site, result }, mark: null, availability: 'ready', onMarkChange: () => {}, ...rest }))
}

/** How deep buttons nest in a piece of HTML: 1 when none is inside another, which is the only valid case. */
function buttonDepth(html: string): number {
  let depth = 0
  let deepest = 0
  for (const tag of html.matchAll(/<(\/?)button\b[^>]*>/g)) {
    depth += tag[1] === '/' ? -1 : 1
    deepest = Math.max(deepest, depth)
  }
  return deepest
}
const buttons = (html: string) => (html.match(/<button\b/g) ?? []).length

describe('SiteRow — the row of a counted site', () => {
  test('its header is a div, not a button: the mark has a button of its own inside it, and a button in a button is not valid', () => {
    const out = row()
    expect(out).not.toMatch(/<button[^>]*class="w-full flex/)
    expect(out).toContain('<div class="w-full flex items-center gap-3 px-4 py-2.5')
    expect(buttonDepth(out)).toBe(1)
    expect(buttonDepth(row({ result: counted({ count: 0, found: false }) }))).toBeLessThanOrEqual(1)
  })

  test('a site with rows has two buttons, the mark and a chevron that says whether the detail is open, with the site in its name', () => {
    const out = row()
    expect(buttons(out)).toBe(2)
    // the mark's own trigger says whether its menu is open as well, so there are two
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(out).toContain('aria-label="Show the details of https://www.corp.example/login"')
    expect(out).toContain('cursor-pointer')
  })

  test('a site with no rows has only the mark button, and nothing to open', () => {
    const out = row({ result: counted({ count: 0, found: false, host_count: 0, subdomain_count: 0, subdomains: 0, top_subdomains: [] }) })
    expect(buttons(out)).toBe(1)
    expect(out).not.toContain('Show the details of')
    expect(out.match(/aria-expanded=/g)).toHaveLength(1) // the mark's trigger only
    expect(out).toContain('cursor-default')
    expect(out).toContain('text-muted-foreground font-normal')
  })

  test('an entry that is not a site has no mark control, only a spacer of the width of the column, so the numbers stay in line', () => {
    const out = row({ site: 'localhost', result: notASite })
    expect(buttons(out)).toBe(0)
    expect(out).toContain('not a site address')
    expect(out).toContain(`<span class="${COLS.mark}"></span>`)
  })

  test('a host the cleaning would change again (three leading www.) has no mark control either', () => {
    const out = row({ result: counted({ host: 'www.corp.example' }) })
    expect(out).not.toContain('aria-label="Mark for')
    expect(out).toContain(`<span class="${COLS.mark}"></span>`)
  })

  test('the mark is for the host the counts named, not for what was typed', () => {
    const out = row()
    expect(out).toContain('aria-label="Mark for corp.example: No mark"')
    expect(out).not.toContain('Mark for https://')
    expect(row({ result: counted({ searched_as: 'corp.example' }) })).toContain('counted as corp.example')
  })

  test('the chevron stops its click, or the row\'s own handler would toggle the detail a second time', () => {
    expect(readFileSync(join(__dirname, '..', 'components/site-count-row.tsx'), 'utf8')).toMatch(/event\.stopPropagation\(\)\s+toggle\(\)/)
  })

  test('the mark sits between the name and the Rows number', () => {
    const out = row()
    const name = out.indexOf('title="https://www.corp.example/login"')
    const markButton = out.indexOf('aria-label="Mark for')
    const rows = out.indexOf('>30</span>')
    expect(name).toBeGreaterThan(0)
    expect(markButton).toBeGreaterThan(name)
    expect(rows).toBeGreaterThan(markButton)
  })

  test('shows what it is given of the mark: a status, a loading state or a failed one', () => {
    expect(row({ mark: mark('done') })).toContain('aria-label="Mark for corp.example: Done"')
    expect(row({ availability: 'loading' })).toContain('aria-label="Loading the mark"')
    expect(row({ availability: 'failed' })).toContain('title="Marks could not be loaded"')
    expect(row({ availability: 'failed' })).not.toContain('No mark')
  })

  test('the numbers and the closed detail are as they were: the rows, and the breakdown for wide windows', () => {
    const out = row()
    expect(out).toContain('>30</span>')
    expect(out).toContain('>20</span>')
    expect(out).toContain('>10</span>')
    expect(out).not.toContain('Subdomains with the most rows')
  })
})

describe('SiteRow — the arrow, the note and the edge', () => {
  test('the arrow sits right after the site text, before the mark, and opens the host the counts name, not what was pasted', () => {
    const out = row()
    const name = out.indexOf('title="https://www.corp.example/login"')
    const arrow = out.indexOf('aria-label="Open corp.example in a new tab"')
    const markButton = out.indexOf('aria-label="Mark for')
    expect(name).toBeGreaterThan(0)
    expect(arrow).toBeGreaterThan(name)
    expect(markButton).toBeGreaterThan(arrow)
    expect(out).toContain('href="https://corp.example/"')
    expect(out).not.toContain('href="https://www.corp.example/login"')
    expect(out).toContain('target="_blank"')
  })

  test('the arrow is a link, not a button: the number of buttons and how they nest are as they were', () => {
    const out = row()
    expect(buttons(out)).toBe(2)
    expect(buttonDepth(out)).toBe(1)
  })

  test('an entry that is not a site has no arrow', () => {
    expect(row({ site: 'localhost', result: notASite })).not.toContain('in a new tab')
  })

  test('a note shows under the site, two lines at most, with a speech bubble; no note, no line', () => {
    const out = row({ mark: mark('skip', 'Invite wall, no signup form') })
    expect(out).toMatch(/<span class="[^"]*line-clamp-2[^"]*">Invite wall, no signup form<\/span>/)
    expect(out).toContain('lucide-message-square')
    expect(row({ mark: mark('skip') })).not.toContain('line-clamp-2')
    expect(row()).not.toContain('line-clamp-2')
    expect(row({ mark: mark(null, 'a note and no status') })).toContain('a note and no status</span>')
  })

  test('a row with a status has an edge in the status colour; a row with only a note, or with nothing, has none', () => {
    for (const status of ['done', 'skip', 'todo'] as const) {
      expect(row({ mark: mark(status) })).toContain(`absolute inset-y-0 left-0 w-1 ${STATUS_STYLE[status].edge}`)
    }
    expect(row({ mark: mark(null, 'only a note') })).not.toContain('absolute inset-y-0 left-0')
    expect(row()).not.toContain('absolute inset-y-0 left-0')
  })

  test('the edge is clipped by the rounded corners of the row, and does not take a click', () => {
    const out = row({ mark: mark('skip') })
    expect(out).toMatch(/^<div class="[^"]*relative[^"]*overflow-hidden/)
    expect(out).toContain('aria-hidden="true" class="absolute inset-y-0 left-0 w-1')
  })

  test('the row is the group the dashed Mark pill shows on when hovered', () => {
    expect(row()).toMatch(/^<div class="[^"]*group\/row/)
  })

  test('a site with no rows can be opened when it has a note, to read all of it; with no note there is still nothing to open', () => {
    const withNote = row({ result: noRows(), mark: mark('skip', 'why') })
    expect(buttons(withNote)).toBe(2)
    expect(withNote).toContain('aria-label="Show the details of https://www.corp.example/login"')
    expect(withNote).toContain('cursor-pointer')
    const without = row({ result: noRows() })
    expect(buttons(without)).toBe(1)
    expect(without).not.toContain('Show the details of')
  })
})

describe('SiteRowBody — what an opened row shows', () => {
  const body = (props: Partial<ComponentProps<typeof SiteRowBody>> = {}) =>
    renderToStaticMarkup(createElement(SiteRowBody, { result: counted(), mark: null, ...props }))

  test('starts with the whole note, line breaks kept, and who set the mark and when', () => {
    const out = body({ mark: mark('skip', 'first line\nsecond line') })
    expect(out).toContain('whitespace-pre-wrap')
    expect(out).toContain('first line\nsecond line')
    expect(out).toContain('a@example.test')
    expect(out.indexOf('first line')).toBeLessThan(out.indexOf('on the site itself'))
  })

  test('the time of the mark reads inside the line it is in: "just now", not "Just now"', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T10:00:20Z'))
    try {
      expect(body({ mark: mark('skip', 'x') })).toContain('a@example.test, just now')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows no note block without a note', () => {
    expect(body()).not.toContain('whitespace-pre-wrap')
    expect(body({ mark: mark('done') })).not.toContain('whitespace-pre-wrap')
  })

  test('each of the top subdomains has an arrow that opens it', () => {
    const out = body({ result: counted({ top_subdomains: [{ domain: 'app.corp.example', count: 10 }, { domain: 'vpn.corp.example', count: 4 }] }) })
    expect(out).toContain('href="https://app.corp.example/"')
    expect(out).toContain('href="https://vpn.corp.example/"')
    expect(out).toContain('aria-label="Open vpn.corp.example in a new tab"')
  })

  test('keeps the numbers and what the Site Directory adds under them', () => {
    const out = body({ extra: createElement('p', null, 'directory part') })
    expect(out).toContain('on the site itself')
    expect(out).toContain('Subdomains with the most rows')
    expect(out).toContain('directory part')
  })
})

describe('the columns', () => {
  test('the mark column is on screen at every width and as wide as its header; every number column from the xl breakpoint, as before', () => {
    expect(COLS.mark).toContain('w-12')
    expect(COLS.mark).not.toContain('hidden')
    expect(COLS.host).toMatch(/hidden xl:block/)
    expect(COLS.subs).toMatch(/hidden xl:block/)
    expect(COLS.distinct).toMatch(/hidden xl:block/)
    expect(COLS.rows).not.toContain('hidden')
  })

  test('a number that was not counted is a dash, never a zero', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(0)).toBe('0')
    expect(fmt(1234)).toBe((1234).toLocaleString())
  })
})
