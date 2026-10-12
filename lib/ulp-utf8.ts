/**
 * The stream parsers decode a file's bytes with Buffer.toString('latin1') so that nothing can throw, and the insert writes the string out as UTF-8.
 * A UTF-8 multi-byte character in the source therefore became two or three characters of mojibake ("café" -> "cafÃ©", stored double-encoded: 0.11% of
 * the stored rows), and a login or url written in a non-Latin script was rejected by the mojibake gate. Every line of the pile that holds a byte of
 * 0x80 or more is valid UTF-8, so the decode can be undone exactly: a line is read as UTF-8 when it is valid UTF-8 and stays Latin-1 text when it is not
 * (a legacy single-byte file). Only the 0.55% of the lines with a high byte pay for it.
 *
 * Used by the stream parsers only. parseLine, parseULPContent and parseBlockContent take strings that may already be real Unicode (lib/legacy-repair.ts
 * hands stored rows to parseLine), so they are not changed.
 */

const HIGH_BYTE = /[\u0080-\u00ff]/
const ABOVE_LATIN1 = /[^\u0000-\u00ff]/
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })

export function repairUtf8Line(line: string): string {
  if (!HIGH_BYTE.test(line) || ABOVE_LATIN1.test(line)) return line
  try {
    return STRICT_UTF8.decode(Buffer.from(line, 'latin1'))
  } catch {
    return line
  }
}
