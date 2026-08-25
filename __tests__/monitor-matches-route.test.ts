/**
 * Source-shape guards for the monitor-matches query plan, plus (in the second
 * describe block below) a behavioral test of the GET route's cache-read
 * response shape.
 *
 * The two-phase query plan guards are deliberately grep-style: they pin the
 * SQL/plan decisions that only show up against a 2.4-billion-row ClickHouse
 * table and so cannot be exercised from a unit test. The route's actual
 * is_new behavior is covered for real, in __tests__/monitor-is-new.test.ts,
 * against a live database.
 *
 * The two-phase query plan itself still lives in lib/monitor-match-resolver.ts,
 * unchanged by Task 9 since the rescan cron and the manual rescan endpoint
 * (app/api/monitoring/monitors/[id]/matches/rescan/route.ts) still call it —
 * so those guards below keep reading resolverSource. As of Task 9 the GET
 * route itself no longer calls the resolver (or ClickHouse) at all: it only
 * reads the SQLite cache those two writers populate. What's left of the
 * route's own shape (auth, the is_new/viewed-cursor ordering) is read from
 * routeSource; error-path behavior for the cache read lives in
 * __tests__/monitor-matches-route-error-handling.test.ts.
 */

import { readFileSync } from 'fs'
import { vi, describe, test, expect } from 'vitest'

vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn(),
}))

vi.mock('@/lib/domain-monitor', () => ({
  getMonitor: vi.fn(),
  getMonitorMatchesCache: vi.fn(),
  markMatchesNewSinceLastView: vi.fn(async (_id: number, _uid: number, rows: unknown[]) =>
    (rows as Record<string, unknown>[]).map(r => ({ ...r, is_new: false }))),
  recordMonitorViewed: vi.fn().mockResolvedValue(undefined),
}))

// final-review Fix 3: the GET route now imports the shared MATCH_LIMIT
// constant from here instead of redeclaring its own copy. Mocked as a plain
// value (rather than vi.importActual, as other test files use when they need
// the resolver's real lock/query behavior) so this file never transitively
// loads lib/clickhouse.ts / lib/ulp-normalize.ts just to read one constant —
// this route makes zero ClickHouse calls, and the mock should reflect that.
vi.mock('@/lib/monitor-match-resolver', () => ({
  MATCH_LIMIT: 100,
}))

describe('monitor matches route — two-phase query plan', () => {
  const routeSource = readFileSync(new URL('../app/api/monitoring/monitors/[id]/matches/route.ts', import.meta.url), 'utf8')
  const resolverSource = readFileSync(new URL('../lib/monitor-match-resolver.ts', import.meta.url), 'utf8')

  test('every plan sorts on exactly the primary-key prefix, no tiebreak', () => {
    // Adding a (url, password) tiebreak forces a sort inside every
    // (domain, email) group. That is affordable only while the candidate set is
    // small, and it is not always small: facebook.com in credential mode
    // resolves 181 email_domain values, so it takes the PRUNED path, where the
    // fuller key measured 14.88 s / 54.75 GiB against 1.25 s / 3.24 GiB for the
    // bare prefix. On a narrow monitor the two are indistinguishable.
    expect(resolverSource).toContain(`const MATCH_ORDER_BY = 'domain, email'`)
    // Display order is still fully pinned — in-process, where sorting 100 rows
    // on all four fields is free — so dropping the SQL tiebreak costs no
    // determinism. Both plans re-sort: the fallback directly, the pruned plan
    // inside mergeMatchPages. The four-field tiebreak itself is covered
    // behaviorally in __tests__/domain-match.test.ts.
    expect(resolverSource).toContain('page.sort(compareMatches)')
    expect(resolverSource).toContain('mergeMatchPages(')
  })

  test('the only ORDER BY is the single primary-key-led constant', () => {
    // ulp.credentials is ORDER BY (domain, email, imported_at). A sort whose
    // leading column is `domain` lets ClickHouse read in primary-key order and
    // stop at LIMIT; anything else materializes and sorts the whole filtered
    // set first — the MEMORY_LIMIT_EXCEEDED production incident documented in
    // app/api/credentials/route.ts's SORT_MAX_MEMORY_BYTES.
    const orderKeys = [...resolverSource.matchAll(/_ORDER_BY = '([^']+)'/g)].map(m => m[1])
    expect(orderKeys.length).toBeGreaterThan(0)
    for (const key of orderKeys) {
      expect(key).toMatch(/^domain\b/)
    }
    // One sort key, interpolated in one place — no per-call-site override that
    // could reintroduce an unaffordable sort.
    const orderBys = resolverSource
      .split('\n')
      .map(line => line.trim())
      // SQL lines only — the surrounding prose explains why this rule exists.
      .filter(line => /^ORDER BY /.test(line))
    expect(orderBys).toEqual(['ORDER BY ${MATCH_ORDER_BY}'])
  })

  test('applies NORM_DOMAIN_EXPR outside the filtered subquery, never beside the WHERE', () => {
    // Two reasons, both load-bearing: the normalization is evaluated on the
    // LIMIT-sized result instead of every scanned row, AND a `(...) AS domain`
    // alias sitting next to a WHERE shadows the real `domain` column inside it,
    // silently converting `domain IN (...)` into an unprunable expression.
    const [outer, inner] = resolverSource.split(/FROM \(\s*\n\s*SELECT url, email, password, domain/)
    expect(inner).toBeDefined()
    expect(outer).toContain('${NORM_DOMAIN_EXPR}) AS domain')
    expect(inner).not.toContain('NORM_DOMAIN_EXPR')
    expect(inner).toContain('WHERE ${where}')
  })

  test('caps the query with a named LIMIT constant', () => {
    expect(resolverSource).toMatch(/MATCH_LIMIT\s*=\s*100/)
    expect(resolverSource).toContain('LIMIT {matchLimit:UInt32}')
  })

  test('gives each phase its own execution-time guard', () => {
    // Phase 1 is a full column scan and phase 2 reads a pruned candidate set;
    // one shared timeout cannot be right for both.
    expect(resolverSource).toMatch(/PHASE1_MAX_EXECUTION_TIME\s*=\s*\d+/)
    expect(resolverSource).toMatch(/PHASE2_MAX_EXECUTION_TIME\s*=\s*\d+/)
    expect(resolverSource).toMatch(/FALLBACK_MAX_EXECUTION_TIME\s*=\s*\d+/)
    expect(resolverSource).toContain('max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}')
    expect(resolverSource).toContain('max_execution_time = ${maxExecutionTime}')
    expect(resolverSource).toContain(`timeout_overflow_mode = 'throw'`)
  })

  // A "phases can never together outlast the route budget" guard used to live
  // here, checking routeSource's `maxDuration` against the resolver's phase
  // timers. Task 9 removes maxDuration from this route along with the
  // ClickHouse call it existed to budget for (GET no longer runs the
  // resolver at all, so there is no request-duration risk left to guard).
  // Note for whoever next touches the rescan route or cron, which still call
  // the resolver directly: neither currently declares its own maxDuration
  // either, but that budget config is a Vercel-only no-op on this project's
  // self-hosted Docker deployment (next.config's `output: 'standalone'`)
  // regardless, so its absence there isn't a regression from this task.

  test('phase 2 ANDs the exact match condition on top of every candidate branch', () => {
    // The IN-lists are pruning accelerators built from raw column values, so
    // they may be over-inclusive; only the shared builder's condition decides
    // what actually matches.
    expect(resolverSource).toContain('buildDomainSetWhereClause(domains, mode)')
    expect(resolverSource).toContain('`${branch.clause} AND ${clause}`')
  })

  test('runs one query per prunable column and merges, rather than ORing them', () => {
    // `domain IN (...) OR email_domain IN (...)` is prunable by neither the
    // primary key nor either bloom filter. Measured on a 'both'-mode monitor:
    // 5.65 s ORed vs 0.25 s split.
    expect(resolverSource).toContain('buildCandidateValueBranches(candidates.columns, NORMALIZED_LEGACY_DOMAINS)')
    expect(resolverSource).toContain('mergeMatchPages([...pages, candidates.legacyRows], MATCH_LIMIT)')
  })

  test('keeps the legacy-normalization bucket out of phase 2 entirely', () => {
    // Folding '' into phase 2's IN-list drags all 21.3M domain-less rows into
    // every request (measured 8.2 s per view). Phase 1 resolves those matches
    // as rows once per cache entry instead, and phase 2 must not re-read them.
    //
    // Both halves are load-bearing and neither replaces the other. Filtering
    // the resolved values keeps the IN-lists small, but only covers the
    // `domain` branch. The `email_domain` branch reaches those same rows
    // WITHOUT their raw `domain` ever appearing in an IN-list — they carry a
    // real email_domain despite a blank/scheme-only domain — so the branch's
    // own `domain NOT IN` is what actually keeps the two pages disjoint.
    // Measured before that exclusion existed: example.com in `both` mode
    // returned 100 rows carrying 42 distinct ones, with every row the `domain`
    // branch found evicted by the duplicates. The merged-page behavior is
    // covered in __tests__/domain-match.test.ts.
    expect(resolverSource).toContain('entry.values.filter(v => !NORMALIZED_LEGACY_DOMAINS.includes(v))')
    expect(resolverSource).toContain('buildCandidateValueBranches(candidates.columns, NORMALIZED_LEGACY_DOMAINS)')
    expect(resolverSource).toMatch(/legacyRows/)
  })

  test('resolves candidate values per match_mode, covering the email side too', () => {
    // match_mode 'credential'/'both' match on the email's domain, which lives
    // in a different column than 'url' matching — phase 1 has to scan whichever
    // column(s) the mode actually uses or those matches are silently lost.
    expect(resolverSource).toContain(`if (mode === 'url' || mode === 'both') columns.push('domain')`)
    expect(resolverSource).toContain(`if (mode === 'credential' || mode === 'both') columns.push('email_domain')`)
  })

  test('falls back to the unpruned plan when the candidate set overflows', () => {
    // A monitor with more distinct matching domains than CANDIDATE_LIMIT
    // certainly has more than MATCH_LIMIT matching rows, so the plain LIMIT
    // short-circuits and the two-phase split would only add work.
    expect(resolverSource).toMatch(/CANDIDATE_LIMIT\s*=\s*\d+/)
    expect(resolverSource).toContain('LIMIT {candidateLimit:UInt32}')
    expect(resolverSource).toContain('candidateLimit: CANDIDATE_LIMIT + 1')
    expect(resolverSource).toContain('if (entry.values.length > CANDIDATE_LIMIT) overflowed = true')
    expect(resolverSource).toContain('candidates.overflowed')
  })

  test('caches phase 1 per (match_mode, domain set) rather than per request', () => {
    expect(resolverSource).toMatch(/CANDIDATE_TTL_MS\s*=\s*\d+\s*\*\s*60_000/)
    expect(resolverSource).toContain('getCandidates(mode, domains)')
    expect(resolverSource).toContain('candidateCacheKey(mode, domains)')
    // The in-flight promise is cached so concurrent misses share one scan, and
    // a rejected scan must be evicted rather than served as an answer.
    expect(resolverSource).toContain('resolution.catch(')
    expect(resolverSource).toContain('candidateCache.delete(key)')
  })

  test('GET makes zero ClickHouse calls — pure cache read via getMonitorMatchesCache', () => {
    // Task 9: this route used to delegate to lib/monitor-match-resolver.ts (a
    // live ClickHouse query, same as the rescan cron / manual rescan endpoint
    // still do); now it only reads the SQLite cache those two writers
    // already populated.
    expect(routeSource).not.toContain('resolveMonitorMatches')
    expect(routeSource).not.toContain('candidateCache')
    // final-review Fix 3: the route DOES import from monitor-match-resolver
    // now — but only the plain MATCH_LIMIT constant, not any query-resolving
    // export. Pin the import to exactly that so a future edit can't quietly
    // reintroduce resolveMonitorMatches (or anything else ClickHouse-shaped)
    // under this same import statement.
    const resolverImport = routeSource.match(/import \{([^}]*)\} from "@\/lib\/monitor-match-resolver"/)
    expect(resolverImport).not.toBeNull()
    expect(resolverImport![1].trim()).toBe('MATCH_LIMIT')
    expect(routeSource).toContain('getMonitorMatchesCache')
  })

  test('requires authentication but not admin', () => {
    expect(routeSource).toContain('validateRequest(request)')
    expect(routeSource).not.toContain('requireAdminRole')
  })

  test('computes is_new against the per-admin cursor before advancing it', () => {
    // Reversing this order would make every match look new forever: the cursor
    // would already be current by the time is_new is computed.
    const markIdx = routeSource.indexOf('markMatchesNewSinceLastView(monitorId, userId, cache.rows)')
    const recordIdx = routeSource.indexOf('recordMonitorViewed(monitorId, userId)')
    expect(markIdx).toBeGreaterThan(-1)
    expect(recordIdx).toBeGreaterThan(markIdx)
  })

  test('documents that recordMonitorViewed is best-effort at the call site', () => {
    // A failure here must not cost the admin the read they just made — see
    // the route's comment. Future readers must not "fix" this by letting a
    // recordMonitorViewed failure fail the whole request.
    const recordIdx = routeSource.indexOf('recordMonitorViewed(monitorId, userId)')
    expect(routeSource.slice(Math.max(0, recordIdx - 300), recordIdx)).toContain('Best-effort')
  })
})

describe('GET .../matches — cache read response shape', () => {
  test('response includes checked_at, never_scanned, and last_error from the cache', async () => {
    const { validateRequest } = await import('@/lib/auth')
    vi.mocked(validateRequest).mockResolvedValue({ userId: '1', role: 'admin' } as never)

    const { getMonitor, getMonitorMatchesCache } = await import('@/lib/domain-monitor')
    vi.mocked(getMonitor).mockResolvedValue({ id: 1, name: 'Wallets', domains: ['trezor.io'], match_mode: 'url' } as never)
    vi.mocked(getMonitorMatchesCache).mockResolvedValue({
      rows: [], status: 'never_scanned', checkedAt: null, lastError: null,
    })

    const { GET } = await import('@/app/api/monitoring/monitors/[id]/matches/route')
    const res = await GET(
      new (await import('next/server')).NextRequest('http://localhost/api/monitoring/monitors/1/matches'),
      { params: Promise.resolve({ id: '1' }) }
    )
    const data = await res.json()

    expect(data.never_scanned).toBe(true)
    expect(data.checked_at).toBeNull()
  })
})
