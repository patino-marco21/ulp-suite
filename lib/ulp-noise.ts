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
 *
 * ── PERFORMANCE (why this is a column, not an inline WHERE predicate) ──────────
 * The first version inlined this as `AND NOT (isIPv4String(domain) OR port(url) !=
 * 0 OR match(lower(url), …) OR …)`. Every one of those is a NON-INDEXABLE per-row
 * function over the wide ZSTD(3) `url`/`domain` columns, and the predicate keeps
 * most rows (not selective) so it can prune nothing. On a Ledger-themed search the
 * token/ngram indexes barely prune (the term is everywhere), so the functions ran
 * over millions of rows — a 78.9 s browse. The default sort (`imported_at DESC`)
 * also isn't the table's ORDER BY prefix, so there's no early-termination from the
 * LIMIT, and the parallel count() (no LIMIT) pays full freight.
 *
 * Fix: bake the logic into a MATERIALIZED `is_noise UInt8` column (DDL v12,
 * computed ONCE at insert from url_host + url), exactly like the other 10
 * materialized columns. The browser/export filter is then a trivial `is_noise = 0`
 * integer compare that ClickHouse auto-moves to PREWHERE — no per-row regex/port
 * parsing, no wide-column read for the filter.
 *
 * {@link NOISE_EXPR} is the single source of truth for the column's MATERIALIZED
 * definition (lib/clickhouse-migrations.ts DDL v12 + the init schema mirror it).
 * {@link isNoiseUrl} mirrors it in JS for unit tests.
 *
 * Escaping: NOISE_EXPR is interpolated into the migration's DDL text. An RE2 `\.`
 * must survive ClickHouse string-literal parsing (`\\` → `\`), so it is written
 * `\\.` in the SQL text → `\\\\.` in this TS template literal — the same convention
 * as the url_host MATERIALIZED expression in lib/clickhouse-migrations.ts.
 *
 * Host checks use `url_host` (materialized, lowercased, port/path-stripped); the
 * :port and .php checks need the raw `url`.
 */
export const NOISE_EXPR = `isIPv4String(url_host)
  OR isIPv6String(url_host)
  OR match(url_host, '^[0-9]{1,3}(\\\\.[0-9]{1,3}){3}')
  OR url_host = 'localhost'
  OR endsWith(url_host, '.local')
  OR port(url) != 0
  OR match(lower(url), '\\\\.php($|[?#])')`

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

/** Host carries an explicit ":port" (mirrors ClickHouse port(url) != 0). */
function hasExplicitPort(url: string): boolean {
  const afterScheme = url.includes('://') ? url.slice(url.indexOf('://') + 3) : url
  const hostPort = afterScheme.split(/[/?#]/, 1)[0]
  const host = hostPort.includes('@') ? hostPort.slice(hostPort.lastIndexOf('@') + 1) : hostPort
  return /:[0-9]{1,5}$/.test(host)
}

/**
 * JS mirror of {@link NOISE_EXPR}. `host` is the port-stripped host (the stored
 * `url_host`/`domain` column); `url` is the full raw URL. Pure + side-effect free.
 */
export function isNoiseUrl(url: string, host: string): boolean {
  const h = (host || '').toLowerCase()
  const u = (url || '').toLowerCase()
  if (!h && !u) return false
  if (IPV4_PREFIX_RE.test(h)) return true
  if (h === 'localhost' || h.endsWith('.local')) return true
  if (hasExplicitPort(u)) return true
  if (PHP_ENDPOINT_RE.test(u)) return true
  return false
}
