/**
 * ClickHouse string literals, for the few places a value must be written into the SQL text instead of passed as a query parameter.
 *
 * Why not always a parameter: parameters travel in the URL, and ClickHouse refuses one longer than http_max_field_value_size (128 KiB:
 * "HTML Form Exception: Field value too long" -- measured 2026-10-03 with 3,000 domains of 43 characters; 40,000 gave "URI too long").
 * The SQL itself travels in the request body, where the limit is max_query_size (256 KiB). A candidate list of a few thousand domains fits
 * there, so lib/search-dictionary-plan.ts inlines it, and caps it by bytes.
 *
 * The escaping rule (a ClickHouse quoted string): a backslash and a single quote are the only characters that end or alter a literal, so
 * those two are escaped; control characters are written as \xHH so no raw NUL or line break travels in the text. Verified live: 25 awkward
 * strings (quotes, backslashes, "'; DROP TABLE", NUL, RTL override, a 4,000-character string, "\x41" as text) came back byte for byte.
 *
 * `reverse()` in ClickHouse is BYTEWISE: reverse('é.com') is 'moc.\xA9\xC3', not 'moc.é'. The reversed-key projection
 * (proj_email_domain_rev, ORDER BY reverse(email_domain)) is matched with exactly those bytes, so a reversed value is built from the UTF-8
 * bytes here and written with \xHH escapes -- never from a reversed JavaScript string, which would silently miss every non-ASCII value.
 */
export function chStringLiteral(value: string): string {
  let out = "'"
  for (const ch of value) {
    const code = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return `${out}'`
}

export function chStringArrayLiteral(values: readonly string[]): string {
  return `[${values.map(chStringLiteral).join(',')}]`
}

/** A literal for raw bytes: printable ASCII as is, the quote and backslash escaped, everything else (and 0x7f) as \xHH. */
export function chBytesLiteral(bytes: Uint8Array): string {
  let out = "'"
  for (const b of bytes) {
    if (b === 0x5c) out += '\\\\'
    else if (b === 0x27) out += "\\'"
    else if (b < 0x20 || b >= 0x7f) out += `\\x${b.toString(16).padStart(2, '0')}`
    else out += String.fromCharCode(b)
  }
  return `${out}'`
}

/** The literal of reverse(value) as ClickHouse computes it on a String: the UTF-8 bytes, last to first. */
export function chReversedLiteral(value: string): string {
  return chBytesLiteral(Buffer.from(value, 'utf8').reverse())
}

export function chReversedArrayLiteral(values: readonly string[]): string {
  return `[${values.map(chReversedLiteral).join(',')}]`
}
