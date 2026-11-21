import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { siteUrl } from '@/lib/site-url'
import { SiteLink } from '@/components/site-link'

const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8')

describe('siteUrl — the address a domain opens', () => {
  test('is the front page of the host over https', () => {
    expect(siteUrl('corp.example')).toBe('https://corp.example/')
    expect(siteUrl('app.eu.corp.example')).toBe('https://app.eu.corp.example/')
    expect(siteUrl('203.0.113.7')).toBe('https://203.0.113.7/')
    expect(siteUrl('xn--mnchen-3ya.example')).toBe('https://xn--mnchen-3ya.example/')
  })

  test('is null for anything that is not a plain host, so a pasted line can never carry a path, a login or a scheme into the link', () => {
    for (const bad of [
      '', ' ', 'corp example', 'corp.example/login', 'corp.example/login:bob:secret', 'corp.example?next=1', 'corp.example#top', 'corp.example:8443',
      'bob@corp.example', 'bob:secret@corp.example', 'https://corp.example', 'javascript:alert(1)', 'data:text/html,x', '//corp.example', 'corp.example\\x',
      '<corp.example>', 'corp.example\n', '%00.example',
    ]) {
      expect(siteUrl(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  test('the result is always an https origin with nothing after the slash', () => {
    for (const host of ['a.example', 'b.c.example', '1.2.3.4']) {
      const url = new URL(siteUrl(host)!)
      expect(url.protocol).toBe('https:')
      expect([url.username, url.password, url.port, url.search, url.hash, url.pathname]).toEqual(['', '', '', '', '', '/'])
    }
  })
})

describe('SiteLink — the arrow beside a domain', () => {
  const link = (props: Parameters<typeof SiteLink>[0]) => renderToStaticMarkup(createElement(SiteLink, props))

  test('is a real link that opens a new tab and tells the opened site nothing about this app', () => {
    const out = link({ host: 'corp.example' })
    expect(out).toContain('<a ')
    expect(out).toContain('href="https://corp.example/"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('referrerPolicy="no-referrer"')
    expect(out).toContain('lucide-arrow-up-right')
  })

  test('has a name for assistive tools and a tooltip that say which site and that it opens a new tab', () => {
    const out = link({ host: 'corp.example' })
    expect(out).toContain('aria-label="Open corp.example in a new tab"')
    expect(out).toContain('title="Open corp.example in a new tab"')
  })

  test('is not a button, so it can sit in a row whose own button count the tests pin', () => {
    expect(link({ host: 'corp.example' })).not.toContain('<button')
  })

  test('with a label it shows the words next to the arrow', () => {
    const out = link({ host: 'corp.example', label: 'Open site' })
    expect(out).toContain('Open site')
    expect(out).toContain('aria-label="Open corp.example in a new tab"')
  })

  test('is nothing at all for a host that is not a plain host', () => {
    expect(link({ host: '' })).toBe('')
    expect(link({ host: 'corp.example/login' })).toBe('')
  })

  test('its click stops at the link: the row it sits in opens its detail on a click, which an arrow must not do', () => {
    expect(source('components/site-link.tsx')).toContain('onClick={event => event.stopPropagation()}')
  })
})
