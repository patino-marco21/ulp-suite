/**
 * Garbage-identity / mojibake classification — the malformed-credential
 * classes neither the parser's existing isJunkCredential gate nor
 * scripts/diagnose-and-purge-garbage.sh's IS_GARBAGE predicate catch today:
 * whitespace inside an email/login, 2+ "@" signs (concatenated records), an
 * @-domain with no letter at all, and non-replacement mojibake (real UTF-8
 * decoded as latin1).
 *
 * Mirrors the lib/ulp-noise.ts split: {@link GARBAGE_EXPR} is the canonical
 * SQL clause (embedded into scripts/diagnose-and-purge-garbage.sh's
 * IS_GARBAGE predicate); {@link hasGarbageIdentity}, {@link hasMojibakeSignature}
 * and {@link hasEdgeWhitespace} are the JS mirror, wired into the parser's
 * isJunkCredential gate (lib/ulp-parser.ts) and unit-tested directly here.
 *
 * Scope: identity (email/login) and url only — NEVER password content. Real
 * emails and URLs are pure ASCII, so whitespace / a letter-less domain /
 * mojibake there is always junk. Passwords are the one field that
 * legitimately carries non-ASCII content (e.g. a real "café123") or internal
 * whitespace (a real passphrase like "correct horse battery"), so every
 * content rule here deliberately exempts password.
 *
 * {@link hasEdgeWhitespace} is the one exception, and it checks structure,
 * not content: no login form accepts, and no person types, a password that
 * starts or ends with a literal tab/newline/CR/space, so a value that
 * differs from its own trim() is a leftover field-separator character the
 * parser failed to fully consume, not real secret content. Applied to
 * password too for that reason (2026-07-03 finding — real ingested data had
 * passwords like "\tcamaro1976" and "\r7q1xnFLmhyfbX^fthH").
 */

/**
 * Lead byte of a 2- or 3-byte UTF-8 sequence (0xC2-0xDF, 0xE0-0xEF -- a
 * contiguous range) immediately followed by a UTF-8 continuation byte
 * (0x80-0xBF). When real UTF-8 bytes are decoded with Buffer.toString('latin1')
 * (see lib/ulp-parser.ts), each original byte maps 1:1 to the Unicode
 * codepoint of the same numeric value, so this exact codepoint-pair is the
 * latin1 "mojibake" signature of a multibyte UTF-8 character -- e.g. Greek d
 * (U+03B4, UTF-8 bytes CE B4) decodes to the 2-char sequence U+00CE U+00B4,
 * which matches. A genuine single accented latin1 character (e.g. the e-acute
 * in a real password "cafe123"-style string) has no continuation byte
 * immediately after it and does not match. Written as a manual charCodeAt
 * loop (numeric comparisons only, no regex escapes) -- the same style as
 * hasBinaryOrReplacement in lib/ulp-parser.ts, which this extends.
 */
export function hasMojibakeSignature(s: string): boolean {
  for (let i = 0; i < s.length - 1; i++) {
    const lead = s.charCodeAt(i)
    const cont = s.charCodeAt(i + 1)
    if (lead >= 0xC2 && lead <= 0xEF && cont >= 0x80 && cont <= 0xBF) return true
  }
  return false
}

/**
 * True if `identity` (an email/login field) is structurally not a real
 * identity: internal whitespace (no real email contains a space — RFC
 * 5321/5322), 2+ "@" signs (a real address has exactly one; two or more is
 * two records concatenated with no separator — 2026-07-03 finding, e.g.
 * "user@gmail.comother@yahoo.de" or "user@gmail.com@gmail.com" — note this
 * must be checked BEFORE the domain-letter check below, which only looks at
 * the text after the LAST "@" and would otherwise see a perfectly normal
 * trailing domain and miss the merge entirely), or an @-domain with no letter
 * at all (every real domain's TLD has letters; catches "x@#", "x@123", and an
 * empty domain after a bare "x@"). Logins with no "@" at all (bare usernames)
 * are only checked for whitespace.
 */
export function hasGarbageIdentity(identity: string): boolean {
  const trimmed = identity.trim()
  if (/\s/.test(trimmed)) return true
  const firstAt = trimmed.indexOf('@')
  if (firstAt === -1) return false
  if (trimmed.indexOf('@', firstAt + 1) !== -1) return true
  const domainPart = trimmed.slice(firstAt + 1)
  return !/[a-z]/i.test(domainPart)
}

/**
 * True if `s` has leading/trailing whitespace or control characters (space,
 * tab, newline, CR) still attached. See the file-level doc comment for why
 * this is applied to password unlike every other rule here: it is a
 * structural check on the field's edges, not on its content.
 */
export function hasEdgeWhitespace(s: string): boolean {
  return s !== s.trim()
}

/**
 * SQL fragment (interpolated into scripts/diagnose-and-purge-garbage.sh's
 * IS_GARBAGE predicate — that script's single-quoted heredoc uses a
 * 2-backslash convention, matching the escaping below). True = drop.
 * `email_domain` is the existing materialized column (lower(domain-part-of-
 * email), '' if no '@') defined in docker/clickhouse/init/01-ulp-tables.sql —
 * reused here rather than recomputed.
 */
export const GARBAGE_EXPR = `(
  match(trimBoth(email), '\\s')
  OR (length(email) - length(replaceAll(email, '@', ''))) >= 2
  OR (position(email,'@') > 0 AND NOT match(email_domain, '[a-z]'))
  OR match(email, '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
  OR match(url,   '[\\x{C2}-\\x{EF}][\\x{80}-\\x{BF}]')
  OR email    != trimBoth(email)
  OR password != trimBoth(password)
)`
