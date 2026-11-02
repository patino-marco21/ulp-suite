/**
 * Parser v6.3, rule N: the promotional signature some Telegram channels put at the end of every record line.
 *
 *   <url>:<login>:<password> ┃ @some_channel promo words / more
 *
 * White space, a heavy vertical bar (U+2503), optional white space and an "@" open it, and it runs to the end of the line. The field split cannot read such a line, and a line that
 * did parse stored the tail inside the password (2026-11-02: three files of one channel, 6.2M stored rows and 13.5M lines that were dropped without a count).
 *
 * The cut is the leftmost match of /\s+┃\s*@[\s\S]*$/, found without a regex: a regex retries from every position of a white-space run, which is quadratic on a run of a
 * million spaces (lib/ulp-telegram-tag.ts had three such cases). Here every character is looked at a constant number of times. The test compares it with the regex on every short string.
 */
const BAR = '┃'
const AT = 64 // '@'

/** The characters of /\s/. */
function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
}

export function stripPromoSignature(line: string): string {
  let bar = line.indexOf(BAR)
  while (bar !== -1) {
    if (bar > 0 && isSpace(line.charCodeAt(bar - 1))) {
      let next = bar + 1
      while (next < line.length && isSpace(line.charCodeAt(next))) next++
      if (line.charCodeAt(next) === AT) {
        let cut = bar - 1
        while (cut > 0 && isSpace(line.charCodeAt(cut - 1))) cut--
        return line.slice(0, cut)
      }
    }
    bar = line.indexOf(BAR, bar + 1)
  }
  return line
}
