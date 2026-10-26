/**
 * Internal Batch Lookup API
 * POST /api/lookup/batch
 *
 * Session-authenticated endpoint (same JWT auth as the dashboard).
 * Accepts up to 100 emails and/or domains, returns a results map keyed
 * by the original query string.
 *
 * Body: { emails?: string[], domains?: string[], imported_after?: string, imported_before?: string }
 *   imported_after / imported_before (UTC; exclusive / inclusive; see lib/imported-range.ts) keep only rows imported in that window.
 * Response: { success, queried, found, results: { [query]: { found, count, results[], searched_as? } } }
 *
 * What is pasted is cleaned to what the table stores before it is compared (lib/batch-input.ts): a domain entry may be a URL, a `www.` host or
 * `host:port`; an e-mail entry may be `<a@b.tld>`, `mailto:a@b.tld` or `a@b.tld:password`. `searched_as` shows what was looked up when it differs.
 * The SQL parts are shared with the v1 route (lib/batch-lookup.ts).
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { executeQuery } from "@/lib/clickhouse"
import { ADDRESS_INDEX_EXPR, ADDRESS_LOOKUP_SETTING } from "@/lib/address-lookup"
import { parseImportedRange, importedRangeEchoIfSet, importedRangePlain, importedRangeAndSql } from "@/lib/imported-range"
import { BATCH_MAX_QUERIES } from "@/lib/batch-input"
import { RESULTS_CAP, stringList, planEmailBatch, emailResults, planDomainBatch, domainIn, domainResults, type BatchResult } from "@/lib/batch-lookup"
export const dynamic = "force-dynamic"

interface EmailRow {
  email: string; password: string; url: string; domain: string
  source_file: string; breach_name: string; imported_at: string
}
interface DomainRow {
  domain: string; email: string; password: string; url: string
  source_file: string; breach_name: string; imported_at: string
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

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
      { success: false, error: "Provide at least one email or domain" },
      { status: 400 }
    )
  }
  if (totalQueries > BATCH_MAX_QUERIES) {
    return NextResponse.json(
      { success: false, error: `Too many queries (${totalQueries}). Maximum is ${BATCH_MAX_QUERIES}.` },
      { status: 422 }
    )
  }

  const results: Record<string, BatchResult> = {}

  const SETTINGS = `SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw', http_wait_end_of_query = 1`

  try {
    // ── Email lookups ──────────────────────────────────────────────────────
    // Index on lower(email) (idx_bf_email_lc, lib/address-lookup.ts): every stored casing of an address matches. NORM_EMAIL_EXPR in WHERE defeated the
    // index — the raw column is correct. LIMIT {cap:UInt32} BY lower(email) guarantees up to RESULTS_CAP rows per queried address (in any casing),
    // fixing the starvation bug where one hot email filled the global cap. The projection setting keeps the planner on the base table, the only place
    // the indexes are used. The group's WHERE also carries the text-index hint that makes a long list fast (lib/batch-lookup.ts).
    if (emails.length > 0) {
      const plan = planEmailBatch(emails)
      const rows: EmailRow[] = []
      for (const group of plan.groups) {
        const part = await executeQuery(
          `SELECT email, password, url, domain, source_file, breach_name, imported_at
           FROM ulp.credentials
           WHERE ${group.where}${rangeAnd}
           ORDER BY ${ADDRESS_INDEX_EXPR} ASC, imported_at DESC
           LIMIT {cap:UInt32} BY ${ADDRESS_INDEX_EXPR}
           ${SETTINGS}, ${ADDRESS_LOOKUP_SETTING}`,
          { ...group.params, ...rangeSql.params, cap: RESULTS_CAP }
        ) as EmailRow[]
        rows.push(...part)
      }
      Object.assign(results, emailResults(plan.entries, rows))
    }

    // ── Domain lookups ─────────────────────────────────────────────────────
    // Raw domain column (the first column of the primary key). An entry is looked up under the bare host it stands for and, when different, the
    // text as typed. LIMIT BY domain prevents one hot domain from consuming all results.
    if (domains.length > 0) {
      const plan = planDomainBatch(domains)
      let rows: DomainRow[] = []
      if (plan.values.length > 0) {
        const lookup = domainIn(plan.values)
        rows = await executeQuery(
          `SELECT domain, email, password, url, source_file, breach_name, imported_at
           FROM ulp.credentials
           WHERE ${lookup.where}${rangeAnd}
           ORDER BY domain ASC, imported_at DESC
           LIMIT {cap:UInt32} BY domain
           ${SETTINGS}`,
          { ...lookup.params, ...rangeSql.params, cap: RESULTS_CAP }
        ) as DomainRow[]
      }
      Object.assign(results, domainResults(plan.entries, rows))
    }

    return NextResponse.json({
      success: true,
      queried: totalQueries,
      found:   Object.values(results).filter(r => r.found).length,
      results,
      ...importedRangeEchoIfSet(importedRange),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timeout')) {
      return NextResponse.json({ success: false, timed_out: true, error: 'Batch lookup timed out — reduce batch size or use more specific queries' }, { status: 408 })
    }
    console.error("Batch lookup error:", error)
    return NextResponse.json({ success: false, error: "Batch lookup failed" }, { status: 500 })
  }
}
