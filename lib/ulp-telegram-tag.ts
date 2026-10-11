/**
 * Telegram channels that repost combo lists append their own link, and sometimes an advert, to the credential lines:
 *
 *   shop.example.test/:alice:Secret1 https://t.me/SomeChannel
 *   https://shop.example.test/login:alice@mail.test:Secret1t.me/SomeChannel  You can buy dm @SomeChannel
 *   shop.example.test/login:alice@mail.test:Secret1          @best_ulp - daily | https://t.me/+AbC123
 *
 * The tag is not part of the password. Left in place it either makes the parser reject the whole line (the extra ':' and '/' break the
 * field split: about 2.7 million lines of one pile) or, when it is glued on, ends up inside the stored password. stripTelegramTag cuts it
 * off so the credential in front of it parses as it would have without it.
 *
 * It is deliberately conservative. It only acts when the link is the END of the line (nothing after it that looks like another field),
 * when a field separator stands in front of it (so a bare invite line is left alone), and, for a link glued straight onto a letter or
 * digit, when that letter is not the end of a host name (`user:pass@payment.me/x`).
 */

const TELEGRAM_LINK = /t\.me\//i
/** A real link boundary: start of the text or a non-alphanumeric character in front of "t.me/" (so "mypost.me/" is not one). */
const LINK_WITH_BOUNDARY = /(?:^|[^A-Za-z0-9])t\.me\//i

/** True when the text holds a Telegram link ("https://t.me/x", " t.me/x"); a host name such as "mypost.me/" does not count. */
export function hasTelegramLink(text: string): boolean {
  return LINK_WITH_BOUNDARY.test(text)
}

export function stripTelegramTag(line: string): string {
  const at = line.search(TELEGRAM_LINK)
  if (at < 0) return line
  const head0 = line.slice(0, at)
  const tail = line.slice(at + 5)

  // The link must be the end of the line: another ':' after it means more fields follow (a real credential whose url is a t.me link).
  if (tail.includes(':')) return line
  // A credential must stand in front of it: at least one field separator that is not the one of a "://" scheme.
  if ((head0.replace(/:\/\//g, '  ').match(/:/g) ?? []).length < 1) return line
  // Glued straight onto a letter or digit: "user:pass@payment.me/x" ends in a host name, not in a tag.
  if (/[A-Za-z0-9]$/.test(head0)) {
    const lastAt = head0.lastIndexOf('@')
    if (lastAt >= 0 && /^[A-Za-z0-9.-]*$/.test(head0.slice(lastAt + 1))) return line
  }

  // Remove what introduces the link: "https://", "https : //", "://", "//", "www." (repeated: "https://https://t.me/").
  let head = head0
  for (;;) {
    const m = /(?:https?\s*:\s*\/\/\s*|\/\/\s*|www\.)$/i.exec(head)
    if (!m) break
    head = head.slice(0, m.index)
  }
  head = head.replace(/[\s:]+$/, '')

  // An advert in front of the link is separated from the password by padding (3 or more white-space characters). Only the text after
  // the last ':' is looked at, so a padded password in an earlier field is never touched.
  const lastColon = head.lastIndexOf(':')
  const padding = /\s{3,}/.exec(head.slice(lastColon + 1))
  if (padding) head = head.slice(0, lastColon + 1 + padding.index)

  return head.replace(/[\s:]+$/, '')
}
