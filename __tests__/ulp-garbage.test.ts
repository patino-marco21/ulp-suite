import { describe, test, expect } from 'vitest'
import { hasGarbageIdentity, hasMojibakeSignature, hasEdgeWhitespace } from '@/lib/ulp-garbage'

describe('ulp-garbage', () => {
  describe('hasGarbageIdentity — whitespace + letter-less domain', () => {
    test.each([
      // [identity, why]
      ['Shubashi @ gmail.com', 'internal whitespace around @'],
      ['jailissalcedo689@ gmail.com', 'space immediately after @'],
      ['y j s J @ i 3 2 Y E G', 'heavily spaced identity'],
      ['@ 1 E x a n d e r', 'spaced, no real local-part'],
      ['x@#', 'punctuation-only domain'],
      ['x@123', 'numeric-only domain'],
      ['x@', 'empty domain after @'],
      ['&aq2ZS*@#', 'real screenshot example — domain is "#"'],
      // 2026-07-03 finding — 2+ "@" signs: concatenated records, no separator
      ['patrick.pikayz.kellner@gmail.comsvengmbh@yahoo.de', 'two full emails concatenated'],
      ['aarongolabiewski@gmail.com@gmail.com', 'duplicate domain appended'],
      ['njc342@gmail.comnjc342@gmail.com', 'entire email duplicated'],
      ['user@a.com@b.com@c.com', 'three "@" signs'],
    ])('garbage: %s (%s)', (identity) => {
      expect(hasGarbageIdentity(identity)).toBe(true)
    })

    test.each([
      // [identity, why] — false-positive guards
      ['john@gmail.com', 'normal real email'],
      ['john_doe', 'bare username, no @ at all'],
      ['user@münchen.de', 'real IDN domain has letters'],
      ['', 'empty string'],
      ['admin@router', 'no-TLD host is a separate concern (is_noise), not garbage here'],
    ])('keep: %s (%s)', (identity) => {
      expect(hasGarbageIdentity(identity)).toBe(false)
    })
  })

  describe('hasMojibakeSignature — latin1 view of UTF-8 multibyte chars', () => {
    test.each([
      // [string, why]
      ['Î´ÎµÎ¹Î»Î¿Ï', 'Greek "δειλοϊ" decoded as latin1'],
      ['Ã©cole', 'French "école" decoded as latin1'],
      ['Ð¿Ñ€Ð¸Ð²Ñ\x82', 'Cyrillic decoded as latin1'],
      ['userÎ´ÎµÎ¹', 'mojibake embedded mid-string'],
    ])('mojibake: %s (%s)', (s) => {
      expect(hasMojibakeSignature(s)).toBe(true)
    })

    test.each([
      // [string, why] — false-positive guards
      ['café123', 'real accented char with no continuation byte after it'],
      ['Müller', 'real accented char (ü) followed by ASCII'],
      ['plain ascii text', 'no high-latin1 chars at all'],
      ['', 'empty string'],
      ['münchen.de', 'real IDN domain'],
    ])('keep: %s (%s)', (s) => {
      expect(hasMojibakeSignature(s)).toBe(false)
    })
  })

  describe('hasEdgeWhitespace — structural check, applies to password too', () => {
    test.each([
      // [string, why] — real 2026-07-03 production examples
      ['\tcamaro1976', 'leading tab'],
      ['\r7q1xnFLmhyfbX^fthH', 'leading carriage return'],
      ['\n  db', 'leading newline + spaces'],
      [' 0414L', 'leading space'],
      ['trailing.tab\t', 'trailing tab'],
    ])('garbage: %j (%s)', (s) => {
      expect(hasEdgeWhitespace(s)).toBe(true)
    })

    test.each([
      // [string, why] — false-positive guards: internal whitespace is content,
      // not a leftover separator, and must be KEPT (real passphrases exist)
      ['correct horse battery', 'passphrase-style password with internal spaces'],
      ['café123', 'real accented content, no edge whitespace'],
      ['P@ss w0rd', 'internal space mid-password'],
      ['', 'empty string'],
      ['plainpassword123', 'no whitespace at all'],
    ])('keep: %s (%s)', (s) => {
      expect(hasEdgeWhitespace(s)).toBe(false)
    })
  })
})
