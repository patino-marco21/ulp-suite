/**
 * Telegram channels that repost combo lists append their own link, and sometimes an advert, to the credential lines:
 *
 *   shop.example.test/:alice:Secret1 https://t.me/SomeChannel
 *   https://shop.example.test/login:alice@mail.test:Secret1t.me/SomeChannel  You can buy dm @SomeChannel
 *   shop.example.test/login:alice@mail.test:Secret1          @best_ulp - daily | https://t.me/+AbC123
 *   shop.example.test/login:alice@mail.test:Secret1://t.me/SomeChannel|NAME;@NAME|https://t.me/+AbC123
 *
 * The tag is not part of the password. Left in place it either makes the parser reject the whole line (the extra ':' and '/' break the
 * field split: about 2.7 million lines of one pile) or, when it is glued on, ends up inside the stored password. stripTelegramTag cuts it
 * off so the credential in front of it parses as it would have without it.
 *
 * It is deliberately conservative. It only acts when the link is the END of the line (nothing after it that looks like another field),
 * when a field separator stands in front of it (so a bare invite line is left alone), and, for a URL with user info, when the link would
 * be the end of its host name (`https://user:pass@payment.me/x`).
 */

const TELEGRAM_LINK = /t\.me\//i
/** A real link boundary: start of the text or a non-alphanumeric character in front of "t.me/" (so "mypost.me/" is not one). */
const LINK_WITH_BOUNDARY = /(?:^|[^A-Za-z0-9])t\.me\//i

/** True when the text holds a Telegram link ("https://t.me/x", " t.me/x"); a host name such as "mypost.me/" does not count. */
export function hasTelegramLink(text: string): boolean {
  return LINK_WITH_BOUNDARY.test(text)
}

const SCHEME_CHAR = /[A-Za-z0-9+.-]/
const LETTER = /[A-Za-z]/
const WHITESPACE = /\s/

/**
 * `tail.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\//g, '').includes(':')` in linear time: is there a ':' that is not the colon of a "scheme://"? The regex starts again at every letter of
 * a long token of letters, digits, '+', '.' and '-', so a token of n characters behind the link cost n*n steps whether or not "://" followed it. A scheme is a whole such
 * token that holds a letter and is followed by "://" (the match starts at its first letter); the scan goes on behind the "://".
 */
export function hasColonOutsideSchemes(tail: string): boolean {
  const n = tail.length
  let i = 0
  while (i < n) {
    const c = tail[i]
    if (c === ':') return true
    if (!SCHEME_CHAR.test(c)) { i++; continue }
    let j = i
    let hasLetter = false
    while (j < n && SCHEME_CHAR.test(tail[j])) { if (!hasLetter && LETTER.test(tail[j])) hasLetter = true; j++ }
    i = hasLetter && tail.startsWith('://', j) ? j + 3 : j
  }
  return false
}

/** `s.replace(/[\s:]+$/, '')` -- the white space and colons at the end -- in linear time (the regex starts again at every position of a run in the middle of the text). */
export function stripTrailingSpaceAndColons(s: string): string {
  let end = s.length
  while (end > 0 && (s[end - 1] === ':' || WHITESPACE.test(s[end - 1]))) end--
  return end === s.length ? s : s.slice(0, end)
}

/** "https://https://t.me/" has two prefixes to take off; tens of thousands of them are not a link but junk, and taking them off one by one re-scans the whole text each time. */
const MAX_LINK_PREFIXES = 64

export function stripTelegramTag(line: string): string {
  const at = line.search(TELEGRAM_LINK)
  if (at < 0) return line
  const head0 = line.slice(0, at)
  const tail = line.slice(at + 5)

  // The link must be the end of the line: another ':' after it means more fields follow (a real credential whose url is a t.me link). The
  // colon of a "https://" in an advert that follows the link ("t.me/Chan|NAME;@NAME|https://t.me/+AbC123") is not a field separator.
  if (hasColonOutsideSchemes(tail)) return line
  // A credential must stand in front of it: at least one field separator that is not the one of a "://" scheme.
  if ((head0.replace(/:\/\//g, '  ').match(/:/g) ?? []).length < 1) return line
  // A URL with user info whose host name merely ends in "t" ("https://user:pass@payment.me/x") is a host, not a tag. Only that exact shape
  // is protected: a scheme, user info (no '/' before the '@') and the start of a host name, nothing else in front of "t.me/". A
  // login:password line whose PASSWORD is an e-mail address ("login:bob@yahoo.comt.me/Channel") is far more common in these lists
  // (2026-10-11: hundreds of rows in single files) and is cut.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]*@[A-Za-z0-9.-]*$/.test(head0)) return line

  // Remove what introduces the link: "https://", "https : //", "://", "//", "www." (repeated: "https://https://t.me/").
  let head = head0
  for (let strips = 0; strips < MAX_LINK_PREFIXES; strips++) {
    const m = /(?:https?\s*:\s*\/\/\s*|\/\/\s*|www\.)$/i.exec(head)
    if (!m) break
    head = head.slice(0, m.index)
  }
  head = stripTrailingSpaceAndColons(head)

  // An advert in front of the link is separated from the password by padding (3 or more white-space characters). Only the text after
  // the last ':' is looked at, so a padded password in an earlier field is never touched.
  const lastColon = head.lastIndexOf(':')
  const padding = /\s{3,}/.exec(head.slice(lastColon + 1))
  if (padding) head = head.slice(0, lastColon + 1 + padding.index)

  return stripTrailingSpaceAndColons(head)
}
