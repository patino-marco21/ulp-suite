/**
 * One quoted CSV cell for the export route.
 *
 * A spreadsheet treats a cell whose first character is = + - @ (or TAB or CR) as a formula, so a password such as
 * `=HYPERLINK("http://...","click")` in an exported file runs when the file is opened ("CSV injection", OWASP). csvCell puts a single
 * quote in front of such a value, which Excel, Sheets and LibreOffice show as plain text, then doubles embedded quotes and wraps the
 * cell in double quotes. Only the first character decides. `guard = false` returns the unguarded bytes for scripts that need them.
 */
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: unknown, guard = true): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (guard && FORMULA_START.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
