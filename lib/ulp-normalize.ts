/**
 * Read-time normalization for corrupted ULP credential rows.
 *
 * Some rows were imported before the parser was patched and have their fields
 * in the wrong columns:
 *
 *   jsessionid rows  (Case A)
 *     email    = 'jsessionid=TOKEN:SERVER:USERNAME:PASSWORD'
 *     password = 'IN https://banking-url.com/...'   (CC-prefix + URL)
 *     url      = ''
 *
 *   CC-prefix URL rows  (Case B)
 *     url = 'IN https://site.com/...'   (leading country-code not stripped)
 *
 *   Scheme-split rows  (Case C)
 *     url   = 'https' or 'http'          (only the scheme stored)
 *     email = '//host/path username'     (URL path + space + actual login merged)
 *     domain = 'https'                   (broken domain derived from scheme-only url)
 *
 *   Monster-material blank-first-tab rows  (Case D)
 *     url      = ''                        (empty leading tab field)
 *     email    = 'site.com/path'           (actual URL landed in email column)
 *     password = 'username:realpassword'   (credential string, may be colon-joined)
 *     domain   = ''
 *
 * These SQL expressions correct the display at query time without waiting for
 * the background ALTER TABLE UPDATE mutations to finish.
 *
 * They are NOT no-ops, though. Measured 2026-10-01 on the 1.39B-row table:
 *
 *   Repaired here. Of the 21.6M rows whose stored domain is '', 'http' or 'https', 3,163,342 (0.23% of
 *   the table) are still changed by these expressions, all with a stored domain of '':
 *     - 2,825,065 + 203,610 are Case D rows whose email column holds a host-like string
 *       ("site.com/path"): real corruption, and the correction recovers a domain for them;
 *     - ~134K are Case D rows whose email column is NOT host-like (a login that merely contains a
 *       '/'): the correction may be rewriting a legitimate row;
 *     - 104 are Case A (jsessionid).
 *   No Case B row exists anywhere in the table (0 of 1.39B) and no space-form Case C row is left.
 *
 *   NOT repaired by any case. 3,288,434 rows (2.17M imported in July, 1.11M in August 2026) have a stored
 *   url of 'http' or 'https' and an email of '//host/path' with no space: the old parser split the URL
 *   at the scheme's colon, and the real login and password sit packed in `password` ("login|pass" or
 *   "login:pass"). Their stored domain is '', and Case C needs a space, so they come back unchanged.
 *   The current parser rejects a leading '//' and handles the blank-first-tab and country-code shapes
 *   at import, so these are historic rows; nothing imported since 2026-08-28.
 *
 * What this means: an exact domain/email filter on the STORED columns cannot see any of these rows (their
 * stored domain is ''), the display repairs only the first group (since 2026-10-01; before that it
 * repaired it only in part -- see NORM_COLS_SETTING), and lib/monitor-match-resolver.ts's legacy probe
 * (which normalizes with these expressions) can only match that first group too. Repairing
 * them in storage means rewriting url/email/password/domain (and every column derived from them, plus
 * proj_imported_desc) in every part, or insert-then-delete under projections; neither is something to run
 * on a table with no backup. See docs/superpowers/specs/2026-09-30-related-panel-and-domain-rev-design.md.
 */

/**
 * Condition: this row is an ORIGINAL-SHAPE jsessionid bank-session entry —
 * the `url` field is EMPTY and the real URL + credentials are packed into the
 * `password` column and the colon-joined `email` (jsessionid=TOKEN:SERVER:
 * USER:PASS). The `url=''` guard is essential and was added 2026-06-14:
 *
 *   diagnose-norm-cols-coverage.sh found 2,984 rows with a perfectly good
 *   `url` (e.g. https://www.billdesk.com/...) and correct `domain`, plus a
 *   BARE `jsessionid=<token>` (no colons) in the email column. Without the
 *   guard the case-A transform fired on those too and DESTROYED them: it
 *   replaced the good url with password garbage, blanked the email, and
 *   emptied the domain. Requiring url='' restricts the transform to rows that
 *   actually match its design; good-url rows fall through to their raw
 *   (correct) values for url/domain and keep their raw email/password.
 */
const JS = `(lower(left(email,11))='jsessionid=' AND url='')`

/** Condition: this row has a country-code prefix in the url column */
const CC = `match(url,'^[A-Za-z]{1,3}\\\\s+https?://')`

/** Condition: url is just the scheme ('http'/'https') with path+login merged in email column */
const C3 = `url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')>0`

/**
 * Condition: Monster-material blank-first-tab rows.
 * url='' + email has no '@' + email contains '/' → email column holds the URL,
 * password column holds the raw credential string.
 * Guards against Case A overlap with the NOT jsessionid check.
 */
const D  = `url='' AND NOT position(email,'@')>0 AND position(email,'/')>0 AND lower(left(email,11))!='jsessionid='`

/** Strip "CC " prefix from a column value */
const strip = (col: string) =>
  `trimLeft(replaceRegexpOne(${col},'^[A-Za-z]{1,3}\\\\s+',''))`

/** For C3: reconstruct the full URL — stored scheme + stored path (first space-segment of email) */
const c3url = `concat(url,':',splitByChar(' ',email)[1])`

/** For C3: extract the actual login — second space-segment of the email column */
const c3email = `splitByChar(' ',email)[2]`

/**
 * For Case D: reconstruct URL from the email column (which holds the URL).
 * The email may be a BARE domain/path ("site.com/path") OR already carry a
 * scheme ("https://account.emofid.com/..."). Only prepend https:// in the bare
 * case — blindly prepending double-schemed the already-schemed rows
 * ("https://https://account...") so domain() returned the junk host "https"
 * (diagnose-norm-cols-coverage.sh, 2026-06-14, ~45,529 case-D rows; most carry
 * a scheme). With the guard, domain(d_url) extracts the real host either way.
 */
const d_url = `if(startsWith(lower(email),'http://') OR startsWith(lower(email),'https://'), email, concat('https://',email))`

/**
 * For Case D: extract actual login from password column.
 * If password contains ':' and the first segment has no '/', treat that segment
 * as the login (e.g. "user@x.com:pass" or "username:pass").
 * Falls back to '' when the credential is a plain hash with no colon.
 */
const d_login = `if(position(password,':')>0 AND NOT position(splitByChar(':',password)[1],'/')>0, splitByChar(':',password)[1], '')`

/**
 * For Case D: extract actual password from password column.
 * Everything after the first colon; or the whole string when there is no colon.
 */
const d_pass = `if(position(password,':')>0 AND NOT position(splitByChar(':',password)[1],'/')>0, arrayStringConcat(arraySlice(splitByChar(':',password),2),':'), password)`

/**
 * Normalized SELECT fragment — drop-in replacement for `url, email, password, domain`
 * in any SELECT list.  Alias names match the original column names so callers need
 * not change anything else.
 */
/**
 * The query setting EVERY query that selects NORM_COLS must carry: `SETTINGS ..., ${NORM_COLS_SETTING}`.
 *
 * NORM_COLS aliases url, email, password and domain to expressions that themselves read url, email,
 * password and domain. With ClickHouse's default (`prefer_column_name_to_alias = 0`, the analyzer
 * since 24.3) a reference to `url` inside the `email` expression resolves to the ALIAS `url` -- the
 * already-normalized value -- not to the stored column the corrections were written against, so the
 * Case A-D conditions stop matching once another alias has rewritten what they test. Measured
 * 2026-10-01 on 20,000 well-formed Case D rows (url '', email "host/path", password "login:pass"),
 * through the exact production form (NORM_COLS in an outer SELECT over a raw-column subquery):
 *
 *                       url      email    password   domain     (rows changed, of 20,000)
 *   default             0        0        13,447     20,000     a half-repaired row: the real domain, the URL
 *                                                                 still in the email column, and a password
 *                                                                 stripped of its login
 *   with this setting   20,000   20,000   19,942     20,000     repaired as designed
 *
 * So until 2026-10-01 the Credentials table, search, export and related panel showed Case D rows
 * garbled, and `email:password` copied from one gave `host/path:password`. Preferring the column makes
 * every reference mean the stored column, which is what the expressions assume. It changes nothing for
 * the rows no case matches (the other 99.5% of the table). __tests__/ulp-normalize-setting.test.ts fails
 * if a module that selects NORM_COLS stops carrying it.
 */
export const NORM_COLS_SETTING = 'prefer_column_name_to_alias = 1'

export const NORM_COLS = `
  if(${JS},
    ${strip('password')},
    if(${CC}, ${strip('url')}, if(${C3}, ${c3url}, if(${D}, ${d_url}, url)))
  ) AS url,
  if(${JS}, arrayElement(splitByChar(':',email),-2), if(${C3}, ${c3email}, if(${D}, ${d_login}, email))) AS email,
  if(${JS}, arrayElement(splitByChar(':',email),-1), if(${D}, ${d_pass}, password)) AS password,
  if(${JS} OR ${CC},
    replaceRegexpOne(
      domain(if(${JS}, ${strip('password')}, ${strip('url')})),
      '^www\\\\.', ''
    ),
    if(${C3},
      replaceRegexpOne(domain(${c3url}), '^www\\\\.', ''),
      if(${D},
        replaceRegexpOne(domain(${d_url}), '^www\\\\.', ''),
        domain
      )
    )
  ) AS domain`

/**
 * Individual field expressions (no alias) — use in DISTINCT queries or
 * anywhere you need just one normalized value.
 */
export const NORM_EMAIL_EXPR  = `if(${JS}, arrayElement(splitByChar(':',email),-2), if(${C3}, ${c3email}, if(${D}, ${d_login}, email)))`
export const NORM_DOMAIN_EXPR = `if(${JS} OR ${CC}, replaceRegexpOne(domain(if(${JS}, ${strip('password')}, ${strip('url')})), '^www\\\\.', ''), if(${C3}, replaceRegexpOne(domain(${c3url}), '^www\\\\.', ''), if(${D}, replaceRegexpOne(domain(${d_url}), '^www\\\\.', ''), domain)))`
export const NORM_URL_EXPR    = `if(${JS}, ${strip('password')}, if(${CC}, ${strip('url')}, if(${C3}, ${c3url}, if(${D}, ${d_url}, url))))`
