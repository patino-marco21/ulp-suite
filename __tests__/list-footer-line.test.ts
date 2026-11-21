import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { ListFooterLine } from '@/components/list-footer-line'

type Props = Parameters<typeof ListFooterLine>[0]
const render = (props: Partial<Props> & Pick<Props, 'kind'>) =>
  renderToStaticMarkup(createElement(ListFooterLine, { rows: 1200, error: null, onLoadMore: () => {}, onStop: () => {}, ...props }))
const text = (html: string) => html.replace(/<[^>]+>/g, '')

// The Credentials page used to hold this component; its words must not change by the move.
describe('ListFooterLine with its defaults (the Credentials page)', () => {
  test('more, end, capped, loading and error say what they said', () => {
    expect(text(render({ kind: 'more' }))).toBe('1,200 rows loaded · scroll for more')
    expect(text(render({ kind: 'end' }))).toBe('1,200 rows · end of the results')
    expect(text(render({ kind: 'capped' }))).toBe('1,200 rows loadedLoad the next rows')
    expect(text(render({ kind: 'loading' }))).toBe('1,200 rows loaded · loading the next rows… 0 sStop')
    expect(text(render({ kind: 'error' }))).toBe('The next rows could not be loaded.Retry')
    expect(text(render({ kind: 'error', error: 'Stopped.' }))).toBe('Stopped.Retry')
  })
})

describe('ListFooterLine with the directory\'s words', () => {
  const words = { noun: 'sites', endLabel: 'end of the directory', slowHint: '' }
  test('names the sites and the end of the directory', () => {
    expect(text(render({ kind: 'more', rows: 212, ...words }))).toBe('212 sites loaded · scroll for more')
    expect(text(render({ kind: 'end', rows: 212, ...words }))).toBe('212 sites · end of the directory')
    expect(text(render({ kind: 'loading', rows: 212, ...words }))).toBe('212 sites loaded · loading the next sites… 0 sStop')
    expect(text(render({ kind: 'capped', rows: 5000, ...words }))).toBe('5,000 sites loadedLoad the next sites')
    expect(text(render({ kind: 'error', ...words }))).toBe('The next sites could not be loaded.Retry')
  })
})
