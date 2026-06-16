/**
 * "Noise" / low-signal URL classification for the credential browser.
 *
 * These rows almost always carry a REAL email + password — they are NOT garbage
 * in the binary/mojibake sense (that is handled, and DELETED, by the parser reject
 * machinery and scripts/diagnose-and-purge-garbage.sh, which deliberately PRESERVE
 * any row with a real email). They are simply low value for a human browsing by
 * target domain, and clutter the results:
 *
 *   - the URL host is a bare IP address (no real domain) — includes private/LAN
 *     IPs (192.168.x, 10.x) and IP-prefixed corruption ("192.168.31.180:5000:x")
 *   - the URL carries an explicit :port — router / Odoo (:8069) / cPanel (:2083)
 *     and other panel endpoints
 *   - the URL is a generic login script ending in .php (wp-login.php, etc.)
 *   - localhost / *.local
 *
 * Filtering here is therefore NON-destructive and view-only: it hides rows from
 * the browser/export, it never deletes them. The UI exposes it as a default-on
 * "Declutter" toggle so the operator can always reveal the full set.
 *
 * The predicate runs against the RAW storage columns (`url`, `domain`). With all
 * data-repair mutations complete those equal the normalized display values, and
 * raw columns keep ClickHouse's primary-key / skip indexes usable (wrapping the
 * NORM_*_EXPR around them would defeat index pruning — see lib/ulp-normalize.ts).
 *
 * ClickHouse semantics relied on:
 *   - port(url)        → the explicit port, or 0 when none (does NOT infer 80/443)
 *   - isIPv4String(s)  → 1 iff s is a valid dotted-quad
 *   - domain column    → host with the port and leading "www." already stripped
 *
 * Escaping: this string is interpolated directly into the SQL text (not a bound
 * parameter), exactly like tierWhereMulti() and the pw_mask IN-list. An RE2 `\.`
 * must survive ClickHouse string-literal parsing, which collapses `\\` → `\`, so
 * the SQL text needs `\\.` — written `\\\\.` in this TS template literal. This is
 * the same convention documented in lib/ulp-normalize.ts.
 */
export const NOISE_PREDICATE = `(
       isIPv4String(domain)
    OR isIPv6String(domain)
    OR match(domain, '^[0-9]{1,3}(\\\\.[0-9]{1,3}){3}')
    OR domain = 'localhost'
    OR endsWith(domain, '.local')
    OR port(url) != 0
    OR match(lower(url), '\\\\.php($|[?#])')
  )`

/**
 * SQL WHERE fragment that removes noise rows when `excludeNoise` is true.
 * Returns ` AND NOT (<noise>)` for appending to an existing WHERE, or '' to keep
 * every row. Mirror of {@link isNoiseUrl} — keep the two in sync.
 */
export function noiseWhere(excludeNoise: boolean): string {
  return excludeNoise ? ` AND NOT ${NOISE_PREDICATE}` : ''
}

// ── JS mirror (executable spec + reusable client-side hint) ─────────────────────

/** Leading dotted-quad — anchored, allows trailing junk (":5000:x"). Mirrors the
 *  SQL isIPv4String + IP-prefix match. Deliberately does NOT match real domains
 *  that merely start with a digit, e.g. "5paisa.com" (no "." after the first run). */
const IPV4_PREFIX_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}/
/** ".php" at the end of the path, optionally followed by ?query / #fragment. */
const PHP_ENDPOINT_RE = /\.php($|[?#])/i

/** Host carries an explicit ":port" (mirrors ClickHouse port(url) != 0). */
function hasExplicitPort(url: string): boolean {
  const afterScheme = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url
  const hostPort = afterScheme.split(/[/?#]/, 1)[0]
  const host = hostPort.includes('@') ? hostPort.slice(hostPort.lastIndexOf('@') + 1) : hostPort
  return /:[0-9]{1,5}$/.test(host)
}

/**
 * JS mirror of {@link NOISE_PREDICATE}. `domain` is the port-stripped host (the
 * stored `domain` column); `url` is the full raw URL. Pure + side-effect free so
 * it can be unit-tested and reused for client-side "noisy URL" hints.
 */
export function isNoiseUrl(url: string, domain: string): boolean {
  const d = (domain || '').toLowerCase()
  const u = (url || '').toLowerCase()
  if (!d && !u) return false
  if (IPV4_PREFIX_RE.test(d)) return true
  if (d === 'localhost' || d.endsWith('.local')) return true
  if (hasExplicitPort(u)) return true
  if (PHP_ENDPOINT_RE.test(u)) return true
  return false
}
