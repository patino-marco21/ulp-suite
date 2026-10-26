/**
 * Batch Lookup API v1
 * POST /api/v1/lookup/batch
 *
 * Submit up to 100 email and/or domain queries in a single request.
 * Returns a result map keyed by the original query string.
 *
 * Body (JSON):
 *   { emails?: string[], domains?: string[], imported_after?: string, imported_before?: string }
 *   imported_after / imported_before (UTC; exclusive / inclusive; see lib/imported-range.ts) keep only rows imported in that window.
 *
 * Each email lookup: exact address match, any casing (indexed)
 * Each domain lookup: exact host match
 *
 * What is sent is cleaned to what the table stores before it is compared (lib/batch-input.ts): a domain entry may be a URL, a `www.` host or
 * `host:port`; an e-mail entry may be `<a@b.tld>`, `mailto:a@b.tld`, `a@b.tld:password` or padded with spaces. A result carries `searched_as` when what
 * was looked up differs from what was sent.
 *
 * Max 100 total queries per request. Results capped at 50 rows per query.
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { ADDRESS_INDEX_EXPR, ADDRESS_LOOKUP_SETTING } from "@/lib/address-lookup"
import { NORM_COLS, NORM_COLS_SETTING } from '@/lib/ulp-normalize'
import { parseImportedRange, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
import { BATCH_MAX_QUERIES } from "@/lib/batch-input"
import { RESULTS_CAP, stringList, planEmailBatch, emailResults, planDomainBatch, domainIn, domainResults, type BatchResult } from "@/lib/batch-lookup"

export const dynamic = "force-dynamic"

// Inner queries filter, sort and LIMIT BY on RAW columns; NORM_COLS is applied to the (at most
// MAX_QUERIES x RESULTS_CAP) rows that survive. NORM_COLS aliases url/email/password/domain, and in a
// single-level SELECT those aliases shadow the stored columns in WHERE / ORDER BY / LIMIT BY, which
// disables the primary-key and bloom-filter pruning that make these lookups cheap (the same defect that
// left the Related panel empty: see lib/related-queries.ts). Measured 2026-09-30 on 1.39B rows: the
// single-level email lookup hit the 30 s cap even for an address with one row; this form takes ~1 s.
// Rows are matched back to the request on the output (normalized) email / domain below, as before.
// Rows in the legacy bucket (stored domain '', 'http' or 'https'; ~22.6M) are found under their stored
// values, as in every other lookup route -- only lib/monitor-match-resolver.ts normalizes them first.
const RAW_COLS = `url, email, password, domain, source_file, breach_name, imported_at`
const OUTER_COLS = `${NORM_COLS}, source_file, breach_name, imported_at`

interface Row {
  email: string; url: string; password: string; domain: string
  source_file: string; breach_name: string; imported_at: string
}

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ["admin", "analyst"])
  if (!authResult.success) {
    return NextResponse.json(
      { success: false, error: authResult.error },
      { status: authResult.status || 401 }
    )
  }

  await logApiRequest(authResult.apiKey!, request, "v1/lookup/batch")

  let body: { emails?: unknown; domains?: unknown; imported_after?: unknown; imported_before?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  // An exact email or domain list is narrowed by the key and the bloom filter, so the plain bound is all it needs.
  const parsedRange = parseImportedRange({ imported_after: body.imported_after, imported_before: body.imported_before })
  if (!parsedRange.ok) {
    return NextResponse.json({ success: false, error: parsedRange.error }, { status: 400 })
  }
  const importedRange = parsedRange.range
  const rangeSql = importedRangePlain(importedRange)
  const rangeAnd = importedRangeAndSql(rangeSql)

  const emails  = stringList(body.emails)
  const domains = stringList(body.domains)

  const totalQueries = emails.length + domains.length
  if (totalQueries === 0) {
    return NextResponse.json(
      { success: false, error: "Provide at least one email or domain in the request body" },
      { status: 400 }
    )
  }
  if (totalQueries > BATCH_MAX_QUERIES) {
    return NextResponse.json(
      { success: false, error: `Too many queries (${totalQueries}). Maximum is ${BATCH_MAX_QUERIES} per request.` },
      { status: 422 }
    )
  }

  const results: Record<string, BatchResult> = {}

  try {
    const SETTINGS = `SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1, ${NORM_COLS_SETTING}`

    // ── Email lookups ────────────────────────────────────────────────────────
    if (emails.length > 0) {
      // Index on lower(email) (idx_bf_email_lc, lib/address-lookup.ts): every stored casing of an address matches.
      // LIMIT {cap} BY lower(email) guarantees up to RESULTS_CAP rows per queried address (in any casing) — fixes starvation bug where one hot email
      // fills the global cap. The projection setting keeps the planner on the base table, the only place the indexes are used. The group's WHERE
      // also carries the text-index hint that makes a long list fast (lib/batch-lookup.ts).
      const plan = planEmailBatch(emails)
      const rows: Row[] = []
      for (const group of plan.groups) {
        const part = await executeQuery(
          `SELECT ${OUTER_COLS}
           FROM (
             SELECT ${RAW_COLS}
             FROM ulp.credentials
             WHERE ${group.where}${rangeAnd}
             ORDER BY ${ADDRESS_INDEX_EXPR} ASC, imported_at DESC
             LIMIT {cap:UInt32} BY ${ADDRESS_INDEX_EXPR}
           ) AS t
           ORDER BY lower(t.email) ASC, t.imported_at DESC
           ${SETTINGS}, ${ADDRESS_LOOKUP_SETTING}`,
          { ...group.params, ...rangeSql.params, cap: RESULTS_CAP }
        ) as Row[]
        rows.push(...part)
      }
      Object.assign(results, emailResults(plan.entries, rows))
    }

    // ── Domain lookups ───────────────────────────────────────────────────────
    // An entry is looked up under the bare host it stands for and, when different, the text as typed.
    if (domains.length > 0) {
      const plan = planDomainBatch(domains)
      let rows: Row[] = []
      if (plan.values.length > 0) {
        const lookup = domainIn(plan.values)
        rows = await executeQuery(
          `SELECT ${OUTER_COLS}
           FROM (
             SELECT ${RAW_COLS}
             FROM ulp.credentials
             WHERE ${lookup.where}${rangeAnd}
             ORDER BY domain ASC, imported_at DESC
             LIMIT {cap:UInt32} BY domain
           ) AS t
           ORDER BY t.domain ASC, t.imported_at DESC
           ${SETTINGS}`,
          { ...lookup.params, ...rangeSql.params, cap: RESULTS_CAP }
        ) as Row[]
      }
      Object.assign(results, domainResults(plan.entries, rows))
    }

    const response = NextResponse.json({
      success: true,
      queried: totalQueries,
      found:   Object.values(results).filter(r => r.found).length,
      results,
      ...importedRangeEchoIfSet(importedRange),
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    console.error("v1 batch lookup error:", error)
    return NextResponse.json({ success: false, error: "Batch lookup failed" }, { status: 500 })
  }
}
