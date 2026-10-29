import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { COLS, SiteRow, fmt } from '@/components/site-count-row'
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
