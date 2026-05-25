/**
 * Login-type classification for ULP credentials.
 *
 * The "email" column in stealer log data is often NOT an email address —
 * it can be a bare username, a phone number, or empty junk.
 *
 * login_type LowCardinality(String) MATERIALIZED column values:
 *   'email'    — has @ with a domain containing a dot (user@domain.tld)
 *   'phone'    — looks like a phone number (E.164 or local format)
 *   'username' — non-empty, not email, not phone
 *   ''         — empty / whitespace only
 *
 * ── Previous bug (fixed) ────────────────────────────────────────────────────
 * The old expression used:
 *   positionCaseInsensitive(email, '.') > position(email, '@') + 1
 * This finds the FIRST dot anywhere in the string. Emails with a dot in the
 * local part — e.g. john.doe@gmail.com (dot at pos 5, @ at pos 9) — would
 * fail because 5 > 10 is false → misclassified as 'username'.
 *
 * Fix: use the 3-arg form  position(email, '.', position(email, '@') + 1)
 * which searches for a dot starting AFTER the @ sign, returning 0 if none.
 * This correctly handles:
 *   john.doe@gmail.com       → email ✓
 *   first.last@company.co.uk → email ✓
 *   j.doe+tag@corp.com       → email ✓
 *   user@localhost            → username ✓ (no dot in domain = AD UPN)
 *
 * ── Phone detection ─────────────────────────────────────────────────────────
 * Broad international pattern with explicit length ceiling (7–18 chars):
 *   ^[+]?[0-9][0-9(). -]{5,16}[0-9]$
 * Matches: +447911123456 | 07842811069 | 1-800-555-0199 | 79161234567
 * Rejects: very long numeric strings that are clearly not phone numbers.
 * (?-s) disables RE2 dotall mode so embedded newlines in junk rows don't
 * accidentally match the pattern.
 */

export type LoginType = 'email' | 'phone' | 'username' | ''

export const LOGIN_TYPE_LABELS: Record<string, string> = {
  email:    'Email addresses',
  phone:    'Phone numbers',
  username: 'Usernames',
  '':       'All login types',
}

export const LOGIN_TYPE_SHORT: Record<string, string> = {
  email:    'Email',
  phone:    'Phone',
  username: 'Username',
  '':       'All',
}

export const VALID_LOGIN_TYPES: ReadonlyArray<string> = ['email', 'phone', 'username', '']

// ─────────────────────────────────────────────────────────────────────────────
// SQL expression — used as MATERIALIZED column expression
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the ClickHouse MATERIALIZED column expression for login_type.
 * References column: email (String)
 *
 * Email: 3-argument position() finds a dot that appears AFTER the @.
 *   position(email, '.', position(email, '@') + 1) > 0
 *   — correctly handles dots in local part (john.doe@...) that the old
 *     approach incorrectly flagged as non-email.
 *
 * Phone: RE2 with (?-s) (disable dotall) and an explicit 7–18 char window.
 *
 * UPN guard: single-label domains (no dot after @) → 'username', matching
 *   Active Directory UPNs like user@corp or user@corp.local where .local
 *   would be in the domain (caught by the dot check already).
 */
export function buildLoginTypeExpression(): string {
  return [
    'multiIf(',
    // ── Email: @ not at start, dot exists in domain part, no spaces ────────
    '  position(email, \'@\') > 1',
    '  AND position(email, \'.\', position(email, \'@\') + 1) > 0',
    '  AND position(email, \' \') = 0,',
    '  \'email\',',
    // ── Phone: E.164 and local formats, 7–18 chars, (?-s) disables dotall ──
    '  match(email, \'(?-s)^[+]?[0-9][0-9(). -]{5,16}[0-9]$\'),',
    '  \'phone\',',
    // ── Username: non-empty after trim ─────────────────────────────────────
    '  length(trimBoth(email)) > 0,',
    '  \'username\',',
    // ── Empty ───────────────────────────────────────────────────────────────
    '  \'\'',
    ')',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// WHERE clause helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHERE clause fragment for login_type multi-select filtering.
 * Pass the selected types; empty array = no filter (show all).
 * Values are validated against VALID_LOGIN_TYPES.
 */
export function loginTypeWhere(types: string[]): string {
  const safe = types.filter(t => VALID_LOGIN_TYPES.includes(t) && t !== '')
  if (safe.length === 0 || safe.length === VALID_LOGIN_TYPES.length - 1) return '' // all selected = no filter
  return ` AND login_type IN (${safe.map(t => `'${t}'`).join(',')})`
}

/**
 * Parse a comma-separated login_type param string into an array.
 * e.g. parseLoginTypeParam('email,phone') → ['email', 'phone']
 */
export function parseLoginTypeParam(param: string): string[] {
  if (!param) return []
  return param.split(',').map(t => t.trim()).filter(t => VALID_LOGIN_TYPES.includes(t) && t !== '')
}
