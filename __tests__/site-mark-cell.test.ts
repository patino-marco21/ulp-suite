import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { MARK_CELL, MarkIcon, SiteMarkCell, SiteMarkMenu } from '@/components/site-mark-cell'
import { SiteMarkFilter } from '@/components/site-mark-filter'
import type { SiteMark } from '@/lib/site-marks-input'

const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')
const mark = (status: SiteMark['status'], note: string | null = null, by: string | null = 'a@example.test', at: string | null = '2026-10-29 10:00:00'): SiteMark => ({
  status, note, updated_by: by, updated_at: at,
})

afterEach(() => vi.useRealTimers())

const cell = (props: Partial<ComponentProps<typeof SiteMarkCell>> = {}) =>
  renderToStaticMarkup(createElement(SiteMarkCell, { host: 'corp.example', mark: null, availability: 'ready', onChange: () => {}, ...props }))

describe('SiteMarkCell — what a row shows before anything is clicked', () => {
  test('while the marks load it is a pulsing dot that cannot be clicked, and it does not say "No mark"', () => {
    const out = cell({ availability: 'loading' })
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-label="Loading the mark"')
    expect(out).toContain('animate-pulse')
    expect(out).not.toContain('<button')
    expect(out).not.toContain('No mark')
  })

  test('when the marks could not be loaded it is a warning that cannot be clicked, and it does not say "No mark"', () => {
    const out = cell({ availability: 'failed' })
    expect(out).toContain('title="Marks could not be loaded"')
    expect(out).toContain('aria-label="Marks could not be loaded"')
    expect(out).not.toContain('<button')
    expect(out).not.toContain('No mark')
  })

  test('a site with no mark is a button with its words, and a faint outline that shows on hover, on focus and on touch screens', () => {
    const out = cell()
    expect(out).toContain('<button')
    expect(out).toContain('aria-label="Mark for corp.example: No mark"')
    expect(out).toContain('title="No mark"')
    expect(out).toContain('aria-haspopup="dialog"')
    expect(out).toContain('opacity-0')
    expect(out).toContain('group-hover/mark:opacity-60')
    expect(out).toContain('group-focus-visible/mark:opacity-60')
    expect(out).toContain('[@media(hover:none)]:opacity-40')
    expect(out).not.toContain('bg-primary')
  })

  test('each status has its own shape and colour, and is not faint', () => {
    const done = cell({ mark: mark('done') })
    expect(done).toContain('text-green-600')
    expect(done).toContain('aria-label="Mark for corp.example: Done"')
    const skip = cell({ mark: mark('skip') })
    expect(skip).toContain('text-red-600')
    expect(skip).toContain('aria-label="Mark for corp.example: Skip"')
    const todo = cell({ mark: mark('todo') })
    expect(todo).toContain('fill-current')
    expect(todo).toContain('text-blue-600')
    expect(todo).toContain('aria-label="Mark for corp.example: To look at"')
    for (const out of [done, skip, todo]) expect(out).not.toContain('opacity-0')
    // three different shapes, not only three colours
    const shapes = [done, skip, todo].map(out => /lucide lucide-([a-z-]+)/.exec(out)?.[1])
    expect(new Set(shapes).size).toBe(3)
  })

  test('a note puts a dot on the icon, and keeps the icon of a site with no status visible', () => {
    const noteOnly = cell({ mark: mark(null, 'behind a captcha') })
    expect(noteOnly).toContain('bg-primary')
    expect(noteOnly).toContain('opacity-60')
    expect(noteOnly).not.toContain('opacity-0')
    expect(noteOnly).toContain('aria-label="Mark for corp.example: No mark, has a note"')
    expect(noteOnly).toContain('behind a captcha')
    expect(cell({ mark: mark('done', 'x') })).toContain('bg-primary')
    expect(cell({ mark: mark('done') })).not.toContain('bg-primary')
  })

  test('the menu is not in the markup until it is opened', () => {
    const out = cell({ mark: mark('done', 'x') })
    expect(out).not.toContain('Optional: why')
    expect(out).not.toContain('Saved when this closes')
  })

  test('every state is as wide as the header above it, so the columns line up', () => {
    expect(MARK_CELL).toContain('w-12')
    for (const availability of ['loading', 'ready', 'failed'] as const) expect(cell({ availability })).toContain(MARK_CELL)
  })

  test('its clicks stop at the cell: the menu is in a portal, whose clicks React would bubble to the row and open its detail', () => {
    expect(source('components/site-mark-cell.tsx')).toContain('onClick={event => event.stopPropagation()}')
  })
})

describe('MarkIcon', () => {
  test('no status is a dashed circle, in the muted colour', () => {
    const out = renderToStaticMarkup(createElement(MarkIcon, { status: null }))
    expect(out).toContain('lucide-circle-dashed')
    expect(out).toContain('text-muted-foreground')
  })
})

const menu = (props: Partial<ComponentProps<typeof SiteMarkMenu>> = {}) =>
  renderToStaticMarkup(createElement(SiteMarkMenu, {
    host: 'corp.example', mark: null, draft: '', onDraftChange: () => {}, onChoose: () => {}, onNoteKeyDown: () => {}, ...props,
  }))

describe('SiteMarkMenu — what the cell opens', () => {
  test('four choices in order, No mark first (not "Clear": the list panel already has one)', () => {
    const out = menu()
    const labels = ['No mark', 'Done', 'Skip', 'To look at'].map(label => out.indexOf(`</svg>${label}</button>`))
    expect(labels.every(i => i > 0)).toBe(true)
    expect([...labels].sort((a, b) => a - b)).toEqual(labels)
    expect(out).not.toContain('Clear')
  })

  test('the current mark is the pressed one, and with no mark it is No mark', () => {
    const pressed = (out: string) => [...out.matchAll(/aria-pressed="true"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?([^<]+)</g)].map(m => m[1])
    expect(pressed(menu())).toEqual(['No mark'])
    expect(pressed(menu({ mark: mark('skip') }))).toEqual(['Skip'])
    expect(pressed(menu({ mark: mark(null, 'a note only') }))).toEqual(['No mark'])
  })

  test('has a note box of at most 500 characters, labelled, with the text of the draft', () => {
    const out = menu({ draft: 'looked at the login page' })
    expect(out).toContain('maxLength="500"')
    expect(out).toContain('>Note</label>')
    expect(out).toContain('>looked at the login page</textarea>')
    expect(out).toContain('Saved when this closes. Ctrl+Enter closes it.')
  })

  test('shows the counter from 400 characters on, not before', () => {
    expect(menu({ draft: 'x'.repeat(399) })).not.toContain('/ 500')
    expect(menu({ draft: 'x'.repeat(400) })).toContain('400 / 500')
    expect(menu({ draft: 'x'.repeat(500) })).toContain('500 / 500')
  })

  test('says who set the mark and when, once the server has said so', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    expect(menu({ mark: mark('done') })).toContain('Set by a@example.test, 2 hours ago')
    expect(menu({ mark: mark('done', null, null, null) })).not.toContain('Set by')
    expect(menu()).not.toContain('Set by')
  })

  test('names the site it is for', () => {
    expect(menu({ host: 'app.corp.example' })).toContain('title="app.corp.example"')
  })
})

describe('SiteMarkFilter — the chips', () => {
  const counts = { all: 12, done: 3, skip: 2, todo: 1, none: 6 }
  const chips = (props: Partial<ComponentProps<typeof SiteMarkFilter>> = {}) =>
    renderToStaticMarkup(createElement(SiteMarkFilter, { value: 'all', counts, disabled: false, onChange: () => {}, ...props }))

  test('All, Done, Skip, To look at, No mark, each with its count', () => {
    const out = chips()
    const order = ['All', 'Done', 'Skip', 'To look at', 'No mark'].map(label => out.indexOf(label))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect([...out.matchAll(/tabular-nums text-muted-foreground">(\d+)</g)].map(m => m[1])).toEqual(['12', '3', '2', '1', '6'])
  })

  test('the chip that is on is pressed and outlined, the others are not', () => {
    const out = chips({ value: 'todo' })
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(4)
    expect(/aria-pressed="true"[^>]*class="[^"]*border-primary/.test(out) || /class="[^"]*border-primary[^"]*"[^>]*aria-pressed="true"/.test(out)).toBe(true)
  })

  test('until the marks are loaded every chip but All is off', () => {
    const out = chips({ disabled: true })
    expect(out.match(/disabled=""/g)).toHaveLength(4)
    expect(chips().match(/disabled=""/g)).toBeNull()
    const all = /<button[^>]*>(?:(?!<\/button>).)*>All</.exec(out)?.[0] ?? ''
    expect(all).not.toContain('disabled=""')
  })

  test('is a group with a name for assistive tools', () => {
    expect(chips()).toContain('role="group"')
    expect(chips()).toContain('aria-label="Show sites by mark"')
  })
})
