/**
 * Parser v6.7: four kinds of field that the parser used to store and that are not a credential. A survey of the source archive (docs/superpowers/specs/2026-11-08-parser-v6-7-design.md)
 * found them in the password or the login of about 0.1% of the stored lines. All four are rejections: no old file yields a row from them, so they need no PARSER_REVISION bump.
 *
 *  1. The text a stealer tool writes when it could not decrypt the browser's password ("Decryption failed.", "Old or unknown version"): the password was not captured.
 *  2. A login without a letter or a digit (two quote characters, question marks that replaced the characters of a name): no identity.
 *  3. A fragment of a JSON object in a field: a line like {"key":"value","k2":"v2"} cut at its first colon into a login `{"key"` and a password `"value","k2":"v2"`.
 *  4. A password that is an advert: it starts with two or more emoji and has white space in it.
 *
 * Every test is linear in the length of the field: a bounded look at the start, or a single left-to-right scan.
 */

const DECRYPT_ERROR_TEXT = new Set([
  'decryption failed.', 'decryption failed', 'old or unknown version', 'unable to decrypt', "can't decode", 'can’t decode', '[unknown or v70]',
])

/** The decrypt-error texts are short; a longer value is never one of them. */
const DECRYPT_ERROR_MAX = 24

export function isDecryptErrorText(password: string): boolean {
  const p = password.trim()
  return p.length <= DECRYPT_ERROR_MAX && DECRYPT_ERROR_TEXT.has(p.toLowerCase().replace(/\s+/g, ' '))
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

export function lacksLetterOrDigit(login: string): boolean {
  return !LETTER_OR_DIGIT.test(login)
}

const JSON_OPEN = /^[[{]\s*"/
const JSON_PAIR_TAIL = /^"[^"]{0,64}"\s*[,:]\s*"/

/** The start of a JSON object or array, or the rest of one after a cut at its first colon (`"value","k2":"v2"`). */
export function isJsonFragment(field: string): boolean {
  return JSON_OPEN.test(field) || JSON_PAIR_TAIL.test(field)
}

const EMOJI_LEAD = /^(?:\p{Extended_Pictographic}️?){2,}/u
const WHITE_SPACE = /\s/

export function isEmojiAd(password: string): boolean {
  return EMOJI_LEAD.test(password) && WHITE_SPACE.test(password)
}

/** True when the login or the password of a built credential is one of the four kinds. */
export function hasFieldJunk(login: string, password: string): boolean {
  return isDecryptErrorText(password) || lacksLetterOrDigit(login) || isJsonFragment(login) || isJsonFragment(password) || isEmojiAd(password)
}
