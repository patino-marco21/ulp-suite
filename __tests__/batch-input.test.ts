import { describe, expect, test } from 'vitest'
import {
  asciiLower, buildBatchRequest, classifyBatchLine, cleanEmailEntry, domainEntry, parseBatchText, prefilterWords, suggestBatchKind,
  BATCH_MAX_ENTRY_LENGTH, PREFILTER_MAX_WORDS, PREFILTER_MAX_WORD_LENGTH,
} from '@/lib/batch-input'
import { extractDomain } from '@/lib/ulp-parser'

describe('asciiLower', () => {
  test('folds A-Z only, like ClickHouse lower()', () => {
    expect(asciiLower('Jane.Doe@Example.COM')).toBe('jane.doe@example.com')
    // JS toLowerCase() would turn the E acute into e acute; the stored lower(email) leaves it alone.
    expect(asciiLower('ÉMILE@X.COM')).toBe('Émile@x.com')
    expect('ÉMILE@X.COM'.toLowerCase()).not.toBe(asciiLower('ÉMILE@X.COM'))
  })
})

describe('parseBatchText', () => {
  test('one entry per line, comma or semicolon; CRLF, blanks and padding are dropped; a repeat is kept once', () => {
    expect(parseBatchText('a.tld\r\n  b.tld \n\n,c.tld;d.tld,,\na.tld')).toEqual(['a.tld', 'b.tld', 'c.tld', 'd.tld'])
  })

  test('a list pasted on ONE line is split only when every word is an address, a host or a URL', () => {
    expect(parseBatchText('a.tld b.tld https://c.tld/x')).toEqual(['a.tld', 'b.tld', 'https://c.tld/x'])
    expect(parseBatchText('a@x.tld b@y.tld')).toEqual(['a@x.tld', 'b@y.tld'])
    // Not lists: a display name, a username with a space.
    expect(parseBatchText('Jane Doe <jane@x.tld>')).toEqual(['Jane Doe <jane@x.tld>'])
    expect(parseBatchText('john smith')).toEqual(['john smith'])
  })
})

describe('domainEntry — the bare host the parser stores', () => {
  test.each([
    ['example.tld', 'example.tld', ['example.tld']],
    ['  Example.TLD  ', 'example.tld', ['example.tld']],
    ['https://example.tld', 'example.tld', ['example.tld']],
    ['https://www.Example.tld/login?next=/a/b#frag', 'example.tld', ['example.tld', 'www.example.tld']],
    ['http://www.example.tld/', 'example.tld', ['example.tld', 'www.example.tld']],
    ['WWW.EXAMPLE.TLD', 'example.tld', ['example.tld', 'www.example.tld']],
    ['https://user:pw@example.tld:8443/x', 'example.tld', ['example.tld']],
    ['//example.tld/x', 'example.tld', ['example.tld', '//example.tld/x']],
    ['android://hash123@com.example.app/', 'com.example.app', ['com.example.app']],
    ['"example.tld",', 'example.tld', ['example.tld', '"example.tld",']],
    ['example.tld.', 'example.tld', ['example.tld', 'example.tld.']],
    ['example.tld?utm=1', 'example.tld', ['example.tld', 'example.tld?utm=1']],
  ])('%s -> host %s, looks for %j', (input, host, candidates) => {
    const entry = domainEntry(input)
    expect(entry.host).toBe(host)
    expect(entry.candidates).toEqual(candidates)
  })

  test('the text as typed stays a candidate when it has no scheme, so no match the old exact comparison found is ever lost', () => {
    // 226,642 rows keep a :port and 1.37 million a /path in `domain` from before the parser stripped them. A decorated input also carries its
    // typed form (one more probe on the primary key's first column, which finds nothing): the rule stays "never fewer matches than before".
    expect(domainEntry('example.tld:8443').candidates).toEqual(['example.tld', 'example.tld:8443'])
    expect(domainEntry('example.tld/').candidates).toEqual(['example.tld', 'example.tld/'])
    // ...but never a URL: no stored domain is one.
    expect(domainEntry('https://example.tld/x').candidates).not.toContain('https://example.tld/x')
  })

  test('nothing usable gives no candidate; an over-long host is not looked up', () => {
    expect(domainEntry('https://')).toEqual({ host: '', candidates: [] })
    expect(domainEntry('   ').candidates).toEqual([])
    expect(domainEntry(`${'a'.repeat(BATCH_MAX_ENTRY_LENGTH + 1)}.tld`).candidates).toEqual([])
  })

  test('hosts are lower-cased the way the parser does it (Unicode included)', () => {
    expect(domainEntry('MÜNCHEN.de').host).toBe('münchen.de')
  })

  // The property that matters: for any URL the parser accepts, the lookup asks for exactly the domain the parser stores.
  test.each([
    'https://www.site.tld/a/b',
    'http://SITE.tld:8080/x',
    'ftp://user@site.tld/f',
    'android://hash@com.pkg.app/',
    'site.tld/path',
    'www.site.tld',
    'https://sub.site.tld',
    'https://site.tld',
    'https://user:pass@www.site.tld:443/x',
    'HTTPS://WWW.SITE.TLD/',
  ])('%s: the host is what extractDomain stores', url => {
    const stored = extractDomain(url)
    expect(stored).not.toBe('')
    expect(domainEntry(url).host).toBe(stored)
    expect(domainEntry(url).candidates).toContain(stored)
  })
})

describe('cleanEmailEntry — the login in what was pasted', () => {
  test.each([
    ['jane@example.tld', 'jane@example.tld'],
    ['  Jane@Example.tld  ', 'Jane@Example.tld'],
    ['<jane@example.tld>', 'jane@example.tld'],
    ['Jane Doe <jane@example.tld>', 'jane@example.tld'],
    ['"jane@example.tld"', 'jane@example.tld'],
    ["'jane@example.tld'", 'jane@example.tld'],
    ['mailto:jane@example.tld', 'jane@example.tld'],
    ['MAILTO:Jane@example.tld', 'Jane@example.tld'],
    ['jane@example.tld:Secret1!', 'jane@example.tld'],
    ['jane@example.tld|Secret1', 'jane@example.tld'],
    ['jane@example.tld.', 'jane@example.tld'],
    ['jane@example.tld,', 'jane@example.tld'],
    ["o'brien@example.tld", "o'brien@example.tld"],
    ['jane+tag@example.tld', 'jane+tag@example.tld'],
    ['​jane@example.tld﻿', 'jane@example.tld'],
  ])('%j -> %j', (input, login) => {
    expect(cleanEmailEntry(input)).toBe(login)
  })

  test('a username or a phone number (no @) is only trimmed and unquoted', () => {
    expect(cleanEmailEntry('  john_smith ')).toBe('john_smith')
    expect(cleanEmailEntry('"john_smith"')).toBe('john_smith')
    expect(cleanEmailEntry('+1 555 0100')).toBe('+1 555 0100')
  })
})

describe('classifyBatchLine / buildBatchRequest — one paste can hold both', () => {
  test('a URL is a domain, an address is an e-mail, anything else follows the Email/Domain choice', () => {
    expect(classifyBatchLine('https://a.tld/x', 'email')).toBe('domain')
    expect(classifyBatchLine('//a.tld/x', 'email')).toBe('domain')
    expect(classifyBatchLine('jane@a.tld', 'domain')).toBe('email')
    expect(classifyBatchLine('jane@a.tld/path', 'domain')).toBe('domain')
    expect(classifyBatchLine('a.tld', 'email')).toBe('email')
    expect(classifyBatchLine('a.tld', 'domain')).toBe('domain')
    expect(classifyBatchLine('john_smith', 'domain')).toBe('domain')
  })

  test('a mixed paste becomes both lists of one request body', () => {
    const text = 'jane@a.tld\nhttps://www.b.tld/login\nc.tld\n<bob@d.tld>\nc.tld'
    expect(buildBatchRequest(text, 'domain')).toEqual({ emails: ['jane@a.tld', '<bob@d.tld>'], domains: ['https://www.b.tld/login', 'c.tld'] })
    // The choice only decides the plain line.
    expect(buildBatchRequest(text, 'email')).toEqual({ emails: ['jane@a.tld', 'c.tld', '<bob@d.tld>'], domains: ['https://www.b.tld/login'] })
  })

  test('the suggested choice is Email as soon as an @ appears, else Domain', () => {
    expect(suggestBatchKind('a.tld\nb.tld')).toBe('domain')
    expect(suggestBatchKind('a.tld\njane@b.tld')).toBe('email')
  })
})

describe('prefilterWords — what the text index holds for a matching row', () => {
  test('the maximal runs of ASCII letters and digits of the lower-cased login, longest first, without repeats', () => {
    expect(prefilterWords('jane.doe+tag@example.co.uk')).toEqual(['example', 'jane', 'doe', 'tag', 'co', 'uk'])
    expect(prefilterWords('a_a-a@a.a')).toEqual(['a'])
    expect(prefilterWords('12345@qq.com')).toEqual(['12345', 'com', 'qq'])
  })

  test('at most 8 words are used, the longest ones', () => {
    const words = prefilterWords('aa.b.cccc.d.eee.f.gggggg.h.iiiii.j@x.tld')!
    expect(words).toHaveLength(PREFILTER_MAX_WORDS)
    expect(words.slice(0, 4)).toEqual(['gggggg', 'iiiii', 'cccc', 'eee'])
  })

  test('no prefilter for a login without a word, with a non-ASCII character, or with a word too long to send', () => {
    expect(prefilterWords('---')).toBeNull()
    expect(prefilterWords('@')).toBeNull()
    expect(prefilterWords('müller@x.tld')).toBeNull()
    expect(prefilterWords(`${'a'.repeat(PREFILTER_MAX_WORD_LENGTH + 1)}@x.tld`)).toBeNull()
    expect(prefilterWords(`${'a'.repeat(PREFILTER_MAX_WORD_LENGTH)}@x.tld`)).not.toBeNull()
  })

  test('a word is never an upper-case run: the caller passes the ASCII-lower-cased login', () => {
    expect(prefilterWords(asciiLower('Jane@Example.COM'))).toEqual(['example', 'jane', 'com'])
  })
})
