/**
 * Internal Batch Lookup API
 * POST /api/lookup/batch
 *
 * Session-authenticated endpoint (same JWT auth as the dashboard).
 * Accepts up to 100 emails and/or domains, returns a results map keyed
 * by the original query string.
 *
 * Body: { emails?: string[], domains?: string[], mode?: "email"|"domain"|"both" }
 * Response: { success, queried, found, results: { [query]: { found, count, results[] } } }
 */

import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { executeQuery } from "@/lib/clickhouse"
export const dynamic = "force-dynamic"

const MAX_QUERIES  = 100
const RESULTS_CAP  = 50

interface BatchResult {
  found: boolean
  count: number
  results: unknown[]
}

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  let body: { emails?: unknown; domains?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const emails  = Array.isArray(body.emails)
    ? (body.emails  as unknown[]).filter(e => typeof e === "string" && e.trim()) as string[]
    : []
  const domains = Array.isArray(body.domains)
    ? (body.domains as unknown[]).filter(d => typeof d === "string" && d.trim()) as string[]
    : []

  const totalQueries = emails.length + domains.length
  if (totalQueries === 0) {
    return NextResponse.json(
      { success: false, error: "Provide at least one email or domain" },
      { status: 400 }
    )
  }
  if (totalQueries > MAX_QUERIES) {
    return NextResponse.json(
      { success: false, error: `Too many queries (${totalQueries}). Maximum is ${MAX_QUERIES}.` },
      { status: 422 }
    )
  }

  const results: Record<string, BatchResult> = {}

  const SETTINGS = `SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw'`

  try {
    // ── Email lookups ──────────────────────────────────────────────────────
    // Raw email column: bloom_filter(0.05) provides fast granule pruning.
    // NORM_EMAIL_EXPR in WHERE defeated the index — raw column is correct now.
    // LIMIT {cap:UInt32} BY email guarantees up to RESULTS_CAP rows per queried
    // address, fixing the starvation bug where one hot email filled the global cap.
    if (emails.length > 0) {
      const emailList = emails.map((_, i) => `{email${i}:String}`).join(", ")
      const emailParams: Record<string, string | number> = {}
      emails.forEach((e, i) => { emailParams[`email${i}`] = e.toLowerCase() })

      const rows = await executeQuery(
        `SELECT email, password, url, domain, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE email IN (${emailList})
         ORDER BY email ASC, imported_at DESC
         LIMIT {cap:UInt32} BY email
         ${SETTINGS}`,
        { ...emailParams, cap: RESULTS_CAP }
      ) as Array<{
        email: string; password: string; url: string; domain: string
        source_file: string; breach_name: string; imported_at: string
      }>

      for (const email of emails) {
        const lc   = email.toLowerCase()
        const hits = rows.filter(r => r.email === lc)
        results[email] = { found: hits.length > 0, count: hits.length, results: hits }
      }
    }

    // ── Domain lookups ─────────────────────────────────────────────────────
    // Raw domain column: bloom_filter provides granule pruning.
    // LIMIT BY domain prevents one hot domain from consuming all results.
    if (domains.length > 0) {
      const domainList = domains.map((_, i) => `{domain${i}:String}`).join(", ")
      const domainParams: Record<string, string | number> = {}
      domains.forEach((d, i) => { domainParams[`domain${i}`] = d.toLowerCase() })

      const rows = await executeQuery(
        `SELECT domain, email, password, url, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE domain IN (${domainList})
         ORDER BY domain ASC, imported_at DESC
         LIMIT {cap:UInt32} BY domain
         ${SETTINGS}`,
        { ...domainParams, cap: RESULTS_CAP }
      ) as Array<{
        domain: string; email: string; password: string; url: string
        source_file: string; breach_name: string; imported_at: string
      }>

      for (const domain of domains) {
        const lc   = domain.toLowerCase()
        const hits = rows.filter(r => r.domain === lc)
        results[domain] = { found: hits.length > 0, count: hits.length, results: hits }
      }
    }

    return NextResponse.json({
      success: true,
      queried: totalQueries,
      found:   Object.values(results).filter(r => r.found).length,
      results,
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
