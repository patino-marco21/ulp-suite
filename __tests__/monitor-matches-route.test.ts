/**
 * Source-shape guards for app/api/monitoring/monitors/[id]/matches/route.ts.
 *
 * These are deliberately grep-style: they pin the SQL/plan decisions that only
 * show up against a 2.4-billion-row ClickHouse table and so cannot be exercised
 * from a unit test. The route's actual is_new behavior is covered for real, in
 * __tests__/monitor-is-new.test.ts, against a live database.
 */

import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('monitor matches route — two-phase query plan', () => {
  const source = readFileSync(new URL('../app/api/monitoring/monitors/[id]/matches/route.ts', import.meta.url), 'utf8')

  test('every plan sorts on exactly the primary-key prefix, no tiebreak', () => {
    // Adding a (url, password) tiebreak forces a sort inside every
    // (domain, email) group. That is affordable only while the candidate set is
    // small, and it is not always small: facebook.com in credential mode
    // resolves 181 email_domain values, so it takes the PRUNED path, where the
    // fuller key measured 14.88 s / 54.75 GiB against 1.25 s / 3.24 GiB for the
    // bare prefix. On a narrow monitor the two are indistinguishable.
    expect(source).toContain(`const MATCH_ORDER_BY = 'domain, email'`)
    // Display order is still fully pinned — in-process, where sorting 100 rows
    // on all four fields is free — so dropping the SQL tiebreak costs no
    // determinism. Both plans re-sort: the fallback directly, the pruned plan
    // inside mergeMatchPages. The four-field tiebreak itself is covered
    // behaviorally in __tests__/domain-match.test.ts.
    expect(source).toContain('page.sort(compareMatches)')
    expect(source).toContain('mergeMatchPages(')
  })

  test('the only ORDER BY is the single primary-key-led constant', () => {
    // ulp.credentials is ORDER BY (domain, email, imported_at). A sort whose
    // leading column is `domain` lets ClickHouse read in primary-key order and
    // stop at LIMIT; anything else materializes and sorts the whole filtered
    // set first — the MEMORY_LIMIT_EXCEEDED production incident documented in
    // app/api/credentials/route.ts's SORT_MAX_MEMORY_BYTES.
    const orderKeys = [...source.matchAll(/_ORDER_BY = '([^']+)'/g)].map(m => m[1])
    expect(orderKeys.length).toBeGreaterThan(0)
    for (const key of orderKeys) {
      expect(key).toMatch(/^domain\b/)
    }
    // One sort key, interpolated in one place — no per-call-site override that
    // could reintroduce an unaffordable sort.
    const orderBys = source
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
    const [outer, inner] = source.split(/FROM \(\s*\n\s*SELECT url, email, password, domain/)
    expect(inner).toBeDefined()
    expect(outer).toContain('${NORM_DOMAIN_EXPR}) AS domain')
    expect(inner).not.toContain('NORM_DOMAIN_EXPR')
    expect(inner).toContain('WHERE ${where}')
  })

  test('caps the query with a named LIMIT constant', () => {
    expect(source).toMatch(/MATCH_LIMIT\s*=\s*100/)
    expect(source).toContain('LIMIT {matchLimit:UInt32}')
  })

  test('gives each phase its own execution-time guard', () => {
    // Phase 1 is a full column scan and phase 2 reads a pruned candidate set;
    // one shared timeout cannot be right for both.
    expect(source).toMatch(/PHASE1_MAX_EXECUTION_TIME\s*=\s*\d+/)
    expect(source).toMatch(/PHASE2_MAX_EXECUTION_TIME\s*=\s*\d+/)
    expect(source).toMatch(/FALLBACK_MAX_EXECUTION_TIME\s*=\s*\d+/)
    expect(source).toContain('max_execution_time = ${PHASE1_MAX_EXECUTION_TIME}')
    expect(source).toContain('max_execution_time = ${maxExecutionTime}')
    expect(source).toContain(`timeout_overflow_mode = 'throw'`)
  })

  test('the phases can never together outlast the route budget', () => {
    // Phase 1 runs, THEN phase 2 or the fallback. If their caps can sum past
    // maxDuration the platform kills the request first and the client gets a
    // generic gateway error instead of the specific timeout response below —
    // which would defeat timeout_overflow_mode = 'throw' and put the dialog
    // back in the "failure indistinguishable from no matches" state this pass
    // exists to fix.
    const num = (name: string) => {
      const m = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))
      expect(m, `${name} not found`).toBeTruthy()
      return Number(m![1])
    }
    const budget = num('maxDuration')
    const phase1 = num('PHASE1_MAX_EXECUTION_TIME')
    const worstSecondPhase = Math.max(num('PHASE2_MAX_EXECUTION_TIME'), num('FALLBACK_MAX_EXECUTION_TIME'))
    expect(phase1 + worstSecondPhase).toBeLessThan(budget)
  })

  test('phase 2 ANDs the exact match condition on top of every candidate branch', () => {
    // The IN-lists are pruning accelerators built from raw column values, so
    // they may be over-inclusive; only the shared builder's condition decides
    // what actually matches.
    expect(source).toContain('buildDomainSetWhereClause(domains, monitor.match_mode)')
    expect(source).toContain('`${branch.clause} AND ${clause}`')
  })

  test('runs one query per prunable column and merges, rather than ORing them', () => {
    // `domain IN (...) OR email_domain IN (...)` is prunable by neither the
    // primary key nor either bloom filter. Measured on a 'both'-mode monitor:
    // 5.65 s ORed vs 0.25 s split.
    expect(source).toContain('buildCandidateValueBranches(candidates.columns, NORMALIZED_LEGACY_DOMAINS)')
    expect(source).toContain('mergeMatchPages([...pages, candidates.legacyRows], MATCH_LIMIT)')
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
    expect(source).toContain('entry.values.filter(v => !NORMALIZED_LEGACY_DOMAINS.includes(v))')
    expect(source).toContain('buildCandidateValueBranches(candidates.columns, NORMALIZED_LEGACY_DOMAINS)')
    expect(source).toMatch(/legacyRows/)
  })

  test('resolves candidate values per match_mode, covering the email side too', () => {
    // match_mode 'credential'/'both' match on the email's domain, which lives
    // in a different column than 'url' matching — phase 1 has to scan whichever
    // column(s) the mode actually uses or those matches are silently lost.
    expect(source).toContain(`if (mode === 'url' || mode === 'both') columns.push('domain')`)
    expect(source).toContain(`if (mode === 'credential' || mode === 'both') columns.push('email_domain')`)
  })

  test('falls back to the unpruned plan when the candidate set overflows', () => {
    // A monitor with more distinct matching domains than CANDIDATE_LIMIT
    // certainly has more than MATCH_LIMIT matching rows, so the plain LIMIT
    // short-circuits and the two-phase split would only add work.
    expect(source).toMatch(/CANDIDATE_LIMIT\s*=\s*\d+/)
    expect(source).toContain('LIMIT {candidateLimit:UInt32}')
    expect(source).toContain('candidateLimit: CANDIDATE_LIMIT + 1')
    expect(source).toContain('if (entry.values.length > CANDIDATE_LIMIT) overflowed = true')
    expect(source).toContain('candidates.overflowed')
  })

  test('caches phase 1 per (match_mode, domain set) rather than per request', () => {
    expect(source).toMatch(/CANDIDATE_TTL_MS\s*=\s*\d+\s*\*\s*60_000/)
    expect(source).toContain('getCandidates(monitor.match_mode, domains)')
    expect(source).toContain('candidateCacheKey(mode, domains)')
    // The in-flight promise is cached so concurrent misses share one scan, and
    // a rejected scan must be evicted rather than served as an answer.
    expect(source).toContain('resolution.catch(')
    expect(source).toContain('candidateCache.delete(key)')
  })

  test('requires authentication but not admin, and rate limits', () => {
    expect(source).toContain('validateRequest(request)')
    expect(source).not.toContain('requireAdminRole')
    expect(source).toContain('checkLimit(matchesLimiter')
    expect(source).toContain('status: 429')
  })

  test('returns a specific timeout response instead of a bare failure', () => {
    // A generic 500 makes the dialog render its empty state, which reads as an
    // authoritative "nothing matches" — see app/monitoring/page.tsx.
    expect(source).toContain('TIMEOUT_EXCEEDED')
    expect(source).toContain('timed_out: true')
    expect(source).toContain('status: 408')
  })

  test('computes is_new against the per-admin cursor before advancing it', () => {
    // Reversing this order would make every match look new forever: the cursor
    // would already be current by the time is_new is computed.
    const markIdx = source.indexOf('markMatchesNewSinceLastView(monitorId, userId, rows)')
    const recordIdx = source.indexOf('recordMonitorViewed(monitorId, userId)')
    expect(markIdx).toBeGreaterThan(-1)
    expect(recordIdx).toBeGreaterThan(markIdx)
  })

  test('documents the last-viewed cursor limitation at the call site', () => {
    // recordMonitorViewed advances the cursor for matches that were never
    // shown (they fell outside MATCH_LIMIT). Accepted tradeoff; the fix is a
    // row-level shown-ledger. Future readers must not mistake it for an
    // oversight and must not "fix" it by moving the call.
    const recordIdx = source.indexOf('recordMonitorViewed(monitorId, userId)')
    expect(source.slice(Math.max(0, recordIdx - 800), recordIdx)).toContain('KNOWN LIMITATION')
  })
})
