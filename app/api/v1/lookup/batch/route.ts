/**
 * Batch Lookup API v1
 * POST /api/v1/lookup/batch
 *
 * Submit up to 100 email and/or domain queries in a single request.
 * Returns a result map keyed by the original query string.
 *
 * Body (JSON):
 *   { emails?: string[], domains?: string[] }
 *
 * Each email lookup: exact email match (bloom-filter accelerated)
 * Each domain lookup: exact domain match
 *
 * Max 100 total queries per request. Results capped at 50 rows per query.
 */

import { NextRequest, NextResponse } from "next/server"
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from "@/lib/api-key-auth"
import { executeQuery } from "@/lib/clickhouse"
import { NORM_EMAIL_EXPR, NORM_DOMAIN_EXPR, NORM_COLS } from '@/lib/ulp-normalize'

export const dynamic = "force-dynamic"

const MAX_QUERIES  = 100
const RESULTS_CAP  = 50

interface BatchResult {
  found: boolean
  count: number
  results: unknown[]
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

  let body: { emails?: unknown; domains?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const emails  = Array.isArray(body.emails)  ? (body.emails  as unknown[]).filter(e => typeof e === "string" && e.trim()) as string[] : []
  const domains = Array.isArray(body.domains) ? (body.domains as unknown[]).filter(d => typeof d === "string" && d.trim()) as string[] : []

  const totalQueries = emails.length + domains.length
  if (totalQueries === 0) {
    return NextResponse.json(
      { success: false, error: "Provide at least one email or domain in the request body" },
      { status: 400 }
    )
  }
  if (totalQueries > MAX_QUERIES) {
    return NextResponse.json(
      { success: false, error: `Too many queries (${totalQueries}). Maximum is ${MAX_QUERIES} per request.` },
      { status: 422 }
    )
  }

  const results: Record<string, BatchResult> = {}

  try {
    const SETTINGS = `SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw'`

    // ── Email lookups ────────────────────────────────────────────────────────
    if (emails.length > 0) {
      // Raw column: bloom_filter(0.05) on email provides fast granule pruning.
      // LIMIT {cap} BY email guarantees up to RESULTS_CAP rows per queried
      // address — fixes starvation bug where one hot email fills the global cap.
      const emailList = emails.map((_, i) => `{email${i}:String}`).join(", ")
      const emailParams: Record<string, string> = {}
      emails.forEach((e, i) => { emailParams[`email${i}`] = e.toLowerCase() })

      const rows = await executeQuery(
        `SELECT ${NORM_COLS}, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE email IN (${emailList})
         ORDER BY email ASC, imported_at DESC
         LIMIT {cap:UInt32} BY email
         ${SETTINGS}`,
        { ...emailParams, cap: RESULTS_CAP }
      ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>

      for (const email of emails) {
        const lc   = email.toLowerCase()
        const hits = rows.filter(r => r.email === lc)
        results[email] = { found: hits.length > 0, count: hits.length, results: hits }
      }
    }

    // ── Domain lookups ───────────────────────────────────────────────────────
    if (domains.length > 0) {
      const domainList = domains.map((_, i) => `{domain${i}:String}`).join(", ")
      const domainParams: Record<string, string> = {}
      domains.forEach((d, i) => { domainParams[`domain${i}`] = d.toLowerCase() })

      const rows = await executeQuery(
        `SELECT ${NORM_COLS}, source_file, breach_name, imported_at
         FROM ulp.credentials
         WHERE domain IN (${domainList})
         ORDER BY domain ASC, imported_at DESC
         LIMIT {cap:UInt32} BY domain
         ${SETTINGS}`,
        { ...domainParams, cap: RESULTS_CAP }
      ) as Array<{ email: string; url: string; password: string; domain: string; source_file: string; breach_name: string; imported_at: string }>

      for (const domain of domains) {
        const lc   = domain.toLowerCase()
        const hits = rows.filter(r => r.domain === lc)
        results[domain] = { found: hits.length > 0, count: hits.length, results: hits }
      }
    }

    const response = NextResponse.json({
      success: true,
      queried: totalQueries,
      found:   Object.values(results).filter(r => r.found).length,
      results,
    })
    return addRateLimitHeaders(response, authResult.rateLimit)
  } catch (error) {
    console.error("v1 batch lookup error:", error)
    return NextResponse.json({ success: false, error: "Batch lookup failed" }, { status: 500 })
  }
}
