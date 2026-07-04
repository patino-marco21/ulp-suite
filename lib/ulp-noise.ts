/**
 * "Noise" / low-signal URL classification for the credential browser.
 *
 * Hides rows that clutter a human browse-by-domain view but usually carry a REAL
 * email + password (so they are filtered, never deleted — see
 * scripts/diagnose-and-purge-garbage.sh, which preserves any row with a real email):
 *   - the URL host is a bare IP address (incl. private/LAN + IP-prefixed corruption)
 *   - the URL carries an explicit :port (router / Odoo :8069 / cPanel :2083)
 *   - the URL is a generic login script ending in .php (wp-login.php, …)
 *   - host is localhost / *.local
 *   - host is a single label with no TLD (http://dev, http://intranet, and the
 *     'http'/'https'-only scheme-split corruption rows)
 *   - browser-internal / non-web schemes (chrome://, chrome-extension://,
 *     moz-extension://, file://, ftp://, data:, javascript:, mailto:, …) — these
 *     are never real site credentials. NOTE: android:// is deliberately NOT noise
 *     (the parser keeps app credentials; they can be high value).
 *   - domain is blank AND (the url is non-blank, or email/password still carries
 *     an embedded ':' — leftover unparsed field structure), or domain doesn't
 *     start with a letter/digit, or domain contains a space or '@'. These are
 *     parser-corruption artifacts (mostly multi-field-joined lines, e.g. a whole
 *     "url:login:pass" line landing in the email or password column) that sort
 *     essentially at random to the front of an alphabetical domain browse.
 *     A genuinely bare "username:password, no site" credential (blank domain,
 *     blank url, no embedded ':' in either field) is deliberately NOT noise —
 *     only ~3% of blank-domain-and-url rows look like this; the rest carry a
 *     colon signaling the real url/login/password got mis-split. Legitimate
 *     hostnames never start with punctuation or contain whitespace/'@';
 *     android:// domains are the app package name (extractDomain strips the
 *     cert-fingerprint prefix), so real android credentials are unaffected.
 *
 * ── PERFORMANCE ───────────────────────────────────────────────────────────────
 * This logic is baked into a MATERIALIZED `is_noise UInt8` column (DDL v12,
 * broadened in v13), computed ONCE at insert. The browser/export filter is a
 * trivial `is_noise = 0` PREWHERE compare — no per-row regex/port parsing over
 * the wide url column. {@link NOISE_EXPR} is the single source of truth for the
 * column's definition (lib/clickhouse-migrations.ts + the init schema mirror it);
 * {@link isNoiseUrl} mirrors it in JS for unit tests.
 *
 * Escaping: NOISE_EXPR is interpolated into DDL text. An RE2 `\.` must survive
 * ClickHouse string-literal parsing (`\\` → `\`), so it is written `\\.` in the
 * SQL text → `\\\\.` in this TS template literal (same convention as the url_host
 * MATERIALIZED expression in lib/clickhouse-migrations.ts).
 */
export const NOISE_EXPR = `isIPv4String(url_host)
  OR isIPv6String(url_host)
  OR match(url_host, '^[0-9]{1,3}(\\\\.[0-9]{1,3}){3}')
  OR url_host = 'localhost'
  OR endsWith(url_host, '.local')
  OR (url != '' AND url_host != '' AND position(url_host, '.') = 0)
  OR port(url) != 0
  OR match(lower(url), '\\\\.php($|[?#])')
  OR match(lower(url), '^(chrome|chrome-extension|moz-extension|edge|opera|brave|vivaldi|about|file|ftp|view-source|data|javascript|mailto):')
  OR (domain = '' AND (url != '' OR position(email, ':') > 0 OR position(password, ':') > 0))
  OR match(domain, '^[^\\\\p{L}\\\\p{N}]')
  OR match(domain, '[ @]')`

/**
 * WHERE term that selects non-noise rows. Reads the precomputed `is_noise` column
 * — a cheap UInt8 compare, NOT the per-row function chain in {@link NOISE_EXPR}.
 */
export const NOISE_FILTER = 'is_noise = 0'

/**
 * SQL fragment that removes noise rows when `excludeNoise` is true.
 * Returns ` AND is_noise = 0` for appending to an existing WHERE, or '' to keep
 * every row.
 */
export function noiseWhere(excludeNoise: boolean): string {
  return excludeNoise ? ` AND ${NOISE_FILTER}` : ''
}

// ── JS mirror of NOISE_EXPR (executable spec for unit tests) ────────────────────

/** Leading dotted-quad — anchored, allows trailing junk (":5000:x"). Mirrors the
 *  SQL isIPv4String + IP-prefix match. Deliberately does NOT match real domains
 *  that merely start with a digit, e.g. "5paisa.com" (no "." after the first run). */
const IPV4_PREFIX_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}/
/** ".php" at the end of the path, optionally followed by ?query / #fragment. */
const PHP_ENDPOINT_RE = /\.php($|[?#])/i
/** Browser-internal / non-web URL schemes — never a real site credential.
 *  android:// is intentionally excluded (app credentials are kept). */
const NONWEB_SCHEME_RE = /^(chrome|chrome-extension|moz-extension|edge|opera|brave|vivaldi|about|file|ftp|view-source|data|javascript|mailto):/i
/** Domain doesn't start with a letter/digit — real hostnames never do; this
 *  catches parser-corruption artifacts (garbled fields, stray leading quotes). */
const DOMAIN_JUNK_PREFIX_RE = /^[^\p{L}\p{N}]/u
/** Domain contains a space or '@' — multi-field-joined corruption residue. */
const DOMAIN_JUNK_CONTENT_RE = /[ @]/

/** Host carries an explicit ":port" (mirrors ClickHouse port(url) != 0). */
function hasExplicitPort(url: string): boolean {
  const afterScheme = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url
  const hostPort = afterScheme.split(/[/?#]/, 1)[0]
  const host = hostPort.includes('@') ? hostPort.slice(hostPort.lastIndexOf('@') + 1) : hostPort
  return /:[0-9]{1,5}$/.test(host)
}

/**
 * JS mirror of {@link NOISE_EXPR}. `host` is the port-stripped host (the stored
 * `url_host`/`domain` column); `url` is the full raw URL. `email`/`password`
 * default to '' for callers that don't have them handy — that only widens the
 * "genuinely bare credential" exemption (never flags a row this function's
 * SQL counterpart would keep), so omitting them is safe, just slightly less
 * precise. Pure + side-effect free.
 */
export function isNoiseUrl(url: string, host: string, email = '', password = ''): boolean {
  const h = (host || '').toLowerCase()
  const u = (url || '').toLowerCase()
  // NOTE: no "both blank → not noise" early return — a genuinely bare
  // "username:password, no site" credential (blank domain, blank url, no
  // embedded ':' in either field) still falls through every check below to
  // the final `return false`. This lets the blank-domain check further down
  // distinguish that case from a mis-split multi-field line.
  if (NONWEB_SCHEME_RE.test(u)) return true
  if (IPV4_PREFIX_RE.test(h)) return true
  if (h === 'localhost' || h.endsWith('.local')) return true
  if (u !== '' && h !== '' && !h.includes('.')) return true  // single-label / no-TLD host
  if (hasExplicitPort(u)) return true
  if (PHP_ENDPOINT_RE.test(u)) return true
  if (h === '' && (u !== '' || email.includes(':') || password.includes(':'))) return true
  if (DOMAIN_JUNK_PREFIX_RE.test(h)) return true
  if (DOMAIN_JUNK_CONTENT_RE.test(h)) return true
  return false
}
