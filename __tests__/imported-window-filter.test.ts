import { readFileSync } from 'fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { ImportedWindowFilter, EMPTY_IMPORTED_WINDOW, type ImportedWindowValue } from '@/components/imported-window-filter'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const NOW = Date.parse('2026-10-18T16:55:30Z')
const CDT = () => 300

const html = (value: ImportedWindowValue) =>
  renderToStaticMarkup(createElement(ImportedWindowFilter, { value, onChange: () => {}, offsetAt: CDT, now: () => NOW }))

describe('ImportedWindowFilter — the pill', () => {
  test('with no window it says so and looks like the other idle chips', () => {
    const out = html(EMPTY_IMPORTED_WINDOW)
    expect(out).toContain('Imported: any time')
    expect(out).toContain('border-border bg-muted/40')
    expect(out).not.toContain('border-primary/30')
  })

  test('a preset keeps its name and the pill turns primary, like an active chip', () => {
    const out = html({ after: '2026-10-17T11:55:30', before: '', source: 'last-24h' })
    expect(out).toContain('Imported: last 24 h')
    expect(out).toContain('border-primary/30 bg-primary/10')
  })

  test('typed values show in the operator\'s time, and the tooltip carries the UTC instants the server uses', () => {
    const out = html({ after: '2026-10-17T00:00:00', before: '2026-10-18T11:55:00', source: null })
    expect(out).toContain('Imported: Oct 17 00:00 → Oct 18 11:55')
    expect(out).toContain('2026-10-17 05:00:00 UTC to 2026-10-18 16:55:00 UTC')
  })

  test('it is a button that opens a dialog, with its text as the accessible name', () => {
    const out = html({ after: '2026-10-17T11:55:30', before: '', source: null })
    expect(out).toContain('type="button"')
    expect(out).toContain('aria-haspopup="dialog"')
    expect(out).toContain('aria-label="Imported: after Oct 17 11:55:30"')
  })

  test('the popover is closed until it is opened (nothing of it in the page markup)', () => {
    const out = html(EMPTY_IMPORTED_WINDOW)
    expect(out).not.toContain('datetime-local')
    expect(out).not.toContain('Apply')
  })
})

describe('ImportedWindowFilter — when a change takes effect (read from the component)', () => {
  const src = read('components/imported-window-filter.tsx')

  test('a preset takes effect at once: it computes the window, hands it to the page and closes', () => {
    expect(src).toContain('WINDOW_PRESETS.map(p => (')
    expect(src).toContain('take({ ...epochsToLocalInputs(presetEpochs(p.key, now(), offsetAt), offsetAt), source: p.key })')
    const take = src.slice(src.indexOf('const take ='), src.indexOf('const commitDraft'))
    expect(take).toContain('onChange(next)')
    expect(take).toContain('setOpen(false)')
  })

  test('typed dates take effect on Enter and on Apply, and only when valid', () => {
    expect(src).toContain("if (e.key === 'Enter')")
    expect((src.match(/onKeyDown=\{onEnter\}/g) ?? []).length).toBe(2) // both fields
    const commit = src.slice(src.indexOf('const commitDraft'), src.indexOf('const onOpenChange'))
    expect(commit).toContain('if (!check.ok) return')
    expect(commit).toContain("take({ after: draftAfter, before: draftBefore, source: null })")
    expect(src).toContain('disabled={!check.ok} onClick={commitDraft}')
  })

  test('closing the popover keeps a changed, valid edit; Escape and an invalid edit are dropped', () => {
    const close = src.slice(src.indexOf('const onOpenChange'), src.indexOf('const onEnter'))
    expect(close).toContain('escaped.current || !check.ok || !changed')
    expect(close).toContain("if (!dropped) onChange({ after: draftAfter, before: draftBefore, source: null })")
    expect(src).toContain('onEscapeKeyDown={() => { escaped.current = true }}')
  })

  test('opening it starts from the applied window, not from an earlier unsaved edit', () => {
    const open = src.slice(src.indexOf('const onOpenChange'), src.indexOf('} else if (open)'))
    expect(open).toContain('setDraftAfter(value.after)')
    expect(open).toContain('setDraftBefore(value.before)')
  })

  test('a window that cannot be sent says why, in place', () => {
    expect(src).toContain('{!check.ok && <p role="alert"')
    expect(src).toContain('checkLocalWindow(draftAfter, draftBefore, offsetAt)')
  })

  test('the page can add presets of its own (Since last export) and a note', () => {
    expect(src).toContain('extraPresets.map(p => (')
    expect(src).toContain('const w = p.resolve()')
    expect(src).toContain('{note}')
  })

  test('both fields show the UTC instant under them, as before', () => {
    expect((src.match(/font-mono text-muted-foreground">= \{utcOf\(/g) ?? []).length).toBe(2)
  })
})

describe('ImportedWindowFilter — the popover fits the screen it opens on (read from the component)', () => {
  const src = read('components/imported-window-filter.tsx')
  const content = src.slice(src.indexOf('<PopoverContent'), src.indexOf('onEscapeKeyDown'))

  // Measured in the browser: 451 px tall at a 768 px high window, opened from a chip row 380 px down, Radix keeps the side with the least overflow and
  // Apply / Clear ended 52 px below the visible area, on a fixed layer the page cannot scroll to.
  test('on a short window the popover scrolls inside the room it has, so Apply and Clear are never below the fold', () => {
    expect(content).toContain('max-h-[var(--radix-popover-content-available-height)]')
    expect(content).toContain('overflow-y-auto')
  })

  // At 375 px the 320 px popover was flush with the right edge of the screen.
  test('on a phone it keeps a margin to the screen edge', () => {
    expect(content).toContain('collisionPadding={8}')
  })

  // With the height capped, Apply sat at the bottom of the scrolled content: pinned, it is in view whatever the window height.
  test('Clear and Apply stay pinned to the bottom of the popover while its content scrolls', () => {
    expect(src).toContain('sticky bottom-0 -mx-3 -mb-3 flex items-center justify-between gap-2 border-t border-border/50 bg-popover px-3 py-2')
  })
})
