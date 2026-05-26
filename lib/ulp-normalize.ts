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
 * the background ALTER TABLE UPDATE mutations to finish.  Once mutations
 * complete, the IF conditions match zero rows and the expressions are no-ops.
 *
 * Escaping note
 * -------------
 * ClickHouse string literals use `\\` for one backslash, so the regex `\s`
 * requires `\\s` in the SQL text.  In a JS template literal `\\\\s` produces
 * the two-character JS string `\\s`, which becomes `\s` after ClickHouse
 * string parsing → whitespace in RE2.  Same logic: `\\.` → `\\\\.` in JS.
 */

/** Condition: this row is a jsessionid bank-session entry */
const JS = `lower(left(email,11))='jsessionid='`

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
 * For Case D: reconstruct URL from the email column (which holds a bare domain/path).
 * Prepend https:// so ClickHouse URL functions can extract the domain.
 */
const d_url = `concat('https://',email)`

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
