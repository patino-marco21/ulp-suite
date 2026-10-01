/**
 * Self-service email check — unauthenticated, rate-limited.
 * GET /api/check?email=alice@example.com
 *
 * Returns breach names only — passwords are NEVER exposed.
 * Designed for end-user self-lookup ("have I been pwned?").
 *
 * Limits (in this order):
 *   • 10 requests per client address per minute — ONLY when a trusted reverse proxy vouches for the address
 *     (TRUST_PROXY_HOPS, lib/client-ip.ts). Without one, the forwarded-address header is whatever the caller
 *     wrote, so it cannot key a limit.
 *   • 60 requests per minute across ALL callers, always. This is what protects ClickHouse when the caller's
 *     address cannot be trusted: every caller shares it, so rotating the header buys nothing.
 *   • 50 requests per email per hour (prevents enumeration via same target)
 *   • 4 lookups in flight at once: an address that matches millions of rows can take 20-30 s, and without a
 *     cap a burst queues up behind them in ClickHouse.
 */

import { NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { checkLimit } from "@/lib/rate-limiter"
import { trustedClientIp } from "@/lib/client-ip"

export const dynamic = "force-dynamic"

// ── In-memory rate limiters (single process; see lib/rate-limiter.ts) ─────────

const ipLimiter     = new Map<string, { count: number; resetAt: number }>()
const emailLimiter  = new Map<string, { count: number; resetAt: number }>()
const globalLimiter = new Map<string, { count: number; resetAt: number }>()

const IP_PER_MINUTE     = 10
const GLOBAL_PER_MINUTE = 60
const MAX_IN_FLIGHT     = 4
let inFlight = 0

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const rawEmail = (searchParams.get("email") || "").trim().toLowerCase()

  if (!rawEmail || !rawEmail.includes("@")) {
    return NextResponse.json(
      { success: false, error: "Provide a valid email address via ?email=" },
      { status: 400 }
    )
  }

  // Per client address: only when a trusted proxy vouches for it (see the header comment).
  const ip = trustedClientIp(request.headers)
  const ipCheck = ip ? checkLimit(ipLimiter, ip, IP_PER_MINUTE, 60_000) : null
  if (ipCheck && !ipCheck.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many requests from your IP. Please wait a minute." },
      {
        status: 429,
        headers: {
          "Retry-After":        String(Math.ceil((ipCheck.resetAt - Date.now()) / 1000)),
          "X-RateLimit-Limit":  String(IP_PER_MINUTE),
          "X-RateLimit-Reset":  String(ipCheck.resetAt),
        },
      }
    )
  }

  // Everyone shares this budget, whatever the forwarded-address header says.
  const globalCheck = checkLimit(globalLimiter, "all", GLOBAL_PER_MINUTE, 60_000)
  if (!globalCheck.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a minute." },
      {
        status: 429,
        headers: {
          "Retry-After":        String(Math.ceil((globalCheck.resetAt - Date.now()) / 1000)),
          "X-RateLimit-Limit":  String(GLOBAL_PER_MINUTE),
          "X-RateLimit-Reset":  String(globalCheck.resetAt),
        },
      }
    )
  }

  // Per-email rate limit: 50 / hour (prevents scraping a specific target)
  const emailCheck = checkLimit(emailLimiter, rawEmail, 50, 3_600_000)
  if (!emailCheck.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many lookups for this email address. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil((emailCheck.resetAt - Date.now()) / 1000)) } }
    )
  }

  if (inFlight >= MAX_IN_FLIGHT) {
    return NextResponse.json(
      { success: false, error: "The service is busy. Please try again in a moment." },
      { status: 503, headers: { "Retry-After": "5", "Cache-Control": "private, no-store" } }
    )
  }
  inFlight++
  try {
    // Return breach names + domains only — NO passwords exposed.
    // email has a bloom_filter skip index — point lookup is fast even at 1.39B rows
    // (measured 2026-09-30: 0.3-1.2 s for ordinary addresses, ~22 s for a very popular one).
    //
    // 'throw', not 'break': 'break' returns whatever had been read when the deadline hit -- a
    // truncated newest-500 list (verified 2026-10-01 with a 3 s cap on a popular address: 500 rows
    // that are not the newest 500), or no rows at all if the matching granules were not reached
    // yet, which is rendered below as "found: false": someone told their address is not in the
    // data when the query simply ran out of time. http_wait_end_of_query keeps a mid-stream
    // timeout from arriving as garbled JSON.
    const rows = await executeQuery(
      `SELECT
         breach_name,
         domain,
         imported_at
       FROM ulp.credentials
       WHERE email = {email:String}
       ORDER BY imported_at DESC
       LIMIT 500
       SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw',
                http_wait_end_of_query = 1, use_query_cache = 0`,
      { email: rawEmail }
    ) as Array<{ breach_name: string; domain: string; imported_at: string }>

    if (rows.length === 0) {
      return NextResponse.json(
        { success: true, email: rawEmail, found: false, breach_count: 0, breaches: [] },
        {
          headers: {
            "X-RateLimit-Remaining": String((ipCheck ?? globalCheck).remaining),
            "Cache-Control":         "private, no-store",
          },
        }
      )
    }

    // Aggregate: group by breach_name, collect unique domains
    const breachMap = new Map<string, { domains: Set<string>; first_seen: string }>()
    for (const row of rows) {
      const key = row.breach_name || "Unknown"
      if (!breachMap.has(key)) {
        breachMap.set(key, { domains: new Set(), first_seen: row.imported_at })
      }
      const entry = breachMap.get(key)!
      if (row.domain) entry.domains.add(row.domain)
      if (row.imported_at < entry.first_seen) entry.first_seen = row.imported_at
    }

    const breaches = Array.from(breachMap.entries())
      .map(([name, { domains, first_seen }]) => ({
        name,
        domains: Array.from(domains).slice(0, 10),
        first_seen,
      }))
      .sort((a, b) => b.first_seen.localeCompare(a.first_seen))

    return NextResponse.json(
      {
        success:      true,
        email:        rawEmail,
        found:        true,
        breach_count: breaches.length,
        breaches,
      },
      {
        headers: {
          "X-RateLimit-Remaining": String((ipCheck ?? globalCheck).remaining),
          "Cache-Control":         "private, no-store",
        },
      }
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes("TIMEOUT_EXCEEDED") || msg.includes("Timeout") || msg.includes("timeout")) {
      // Not "found: false": we do not know. Say so, and let the client retry.
      return NextResponse.json(
        { success: false, timed_out: true, error: "The lookup took too long. Please try again in a moment." },
        { status: 503, headers: { "Retry-After": "30", "Cache-Control": "private, no-store" } }
      )
    }
    console.error("Check API error:", error)
    return NextResponse.json({ success: false, error: "Lookup failed" }, { status: 500 })
  } finally {
    inFlight--
  }
}
