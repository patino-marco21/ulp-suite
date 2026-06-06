/**
 * Self-service email check — unauthenticated, rate-limited.
 * GET /api/check?email=alice@example.com
 *
 * Returns breach names only — passwords are NEVER exposed.
 * Designed for end-user self-lookup ("have I been pwned?").
 *
 * Rate limits:
 *   • 10 requests per IP per minute
 *   • 50 requests per email per hour (prevents enumeration via same target)
 */

import { NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"

export const dynamic = "force-dynamic"

// ── In-memory rate limiters (edge-compatible) ─────────────────────────────────

const ipLimiter    = new Map<string, { count: number; resetAt: number }>()
const emailLimiter = new Map<string, { count: number; resetAt: number }>()

function checkLimit(
  map: Map<string, { count: number; resetAt: number }>,
  key: string,
  maxCount: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()

  // Periodic cleanup to prevent unbounded growth
  if (map.size > 5000) {
    for (const [k, v] of map) {
      if (now > v.resetAt) map.delete(k)
    }
  }

  const entry = map.get(key)
  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs
    map.set(key, { count: 1, resetAt })
    return { allowed: true, remaining: maxCount - 1, resetAt }
  }

  if (entry.count >= maxCount) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { allowed: true, remaining: maxCount - entry.count, resetAt: entry.resetAt }
}

function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  )
}

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

  const ip = getClientIP(request)

  // IP rate limit: 10 / minute
  const ipCheck = checkLimit(ipLimiter, ip, 10, 60_000)
  if (!ipCheck.allowed) {
    return NextResponse.json(
      { success: false, error: "Too many requests from your IP. Please wait a minute." },
      {
        status: 429,
        headers: {
          "Retry-After":        String(Math.ceil((ipCheck.resetAt - Date.now()) / 1000)),
          "X-RateLimit-Limit":  "10",
          "X-RateLimit-Reset":  String(ipCheck.resetAt),
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

  try {
    // Return breach names + domains only — NO passwords exposed.
    // email is in the primary key (ORDER BY domain, email, imported_at) and has a
    // bloom_filter skip index — point lookup is fast even at 1.46B rows.
    const rows = await executeQuery(
      `SELECT
         breach_name,
         domain,
         imported_at
       FROM ulp.credentials
       WHERE email = {email:String}
       ORDER BY imported_at DESC
       LIMIT 500
       SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break'`,
      { email: rawEmail }
    ) as Array<{ breach_name: string; domain: string; imported_at: string }>

    if (rows.length === 0) {
      return NextResponse.json(
        { success: true, email: rawEmail, found: false, breach_count: 0, breaches: [] },
        {
          headers: {
            "X-RateLimit-Remaining": String(ipCheck.remaining),
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
          "X-RateLimit-Remaining": String(ipCheck.remaining),
          "Cache-Control":         "private, no-store",
        },
      }
    )
  } catch (error) {
    console.error("Check API error:", error)
    return NextResponse.json({ success: false, error: "Lookup failed" }, { status: 500 })
  }
}
