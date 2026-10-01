import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { RELATED_BY_EMAIL_SQL, RELATED_BY_DOMAIN_SQL, RELATED_BY_PASSWORD_SQL } from "@/lib/related-queries"

export const dynamic = 'force-dynamic'

/**
 * GET /api/related?email=X&password=Y&domain=Z
 * Returns three buckets of related credentials:
 *   by_email    — same email address, different rows (cross-domain reuse)
 *   by_domain   — same domain, different email (exposure breadth)
 *   by_password — same password, different email (password reuse)
 *
 * Up to 25 results per bucket, each ~1 s on the 1.39B-row table. The SQL lives in
 * lib/related-queries.ts, which explains why it is shaped the way it is (raw-column inner
 * query, primary-key-order sample) -- an earlier single-level form ran into its 30 s cap on
 * every call and returned nothing.
 *
 * The buckets are independent: one that cannot be computed (timeout or error) comes back empty
 * and is named in `failed`, so the panel can say "timed out" instead of "none found" while the
 * others still show. Only when every requested bucket fails is the request itself an error.
 */

const BUCKETS = ['by_email', 'by_domain', 'by_password'] as const

function isTimeout(reason: unknown): boolean {
  const msg = reason instanceof Error ? reason.message : String(reason)
  return msg.includes('TIMEOUT_EXCEEDED') || msg.includes('Timeout') || msg.includes('timeout')
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const sp       = new URL(request.url).searchParams
  const email    = sp.get('email')    || ''
  const password = sp.get('password') || ''
  const domain   = sp.get('domain')  || ''

  if (!email && !domain) {
    return NextResponse.json({ success: false, error: 'email or domain required' }, { status: 400 })
  }

  const asked = [!!email, !!domain, !!password && password.length >= 3]

  const settled = await Promise.allSettled([
    // By email — all credentials sharing this login (cross-domain reuse)
    email
      ? executeQuery(RELATED_BY_EMAIL_SQL, { email })
      : Promise.resolve([]),

    // By domain — other logins on the same domain
    domain
      ? executeQuery(RELATED_BY_DOMAIN_SQL, { domain, email })
      : Promise.resolve([]),

    // By password — other accounts using the exact same password
    password && password.length >= 3
      ? executeQuery(RELATED_BY_PASSWORD_SQL, { password, email })
      : Promise.resolve([]),
  ])

  const rows: Record<(typeof BUCKETS)[number], unknown[]> = { by_email: [], by_domain: [], by_password: [] }
  const failed: string[] = []
  let timedOut = false
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      rows[BUCKETS[i]] = result.value
      return
    }
    failed.push(BUCKETS[i])
    if (isTimeout(result.reason)) timedOut = true
    else console.error(`Related query error (${BUCKETS[i]}):`, result.reason)
  })

  if (failed.length > 0 && failed.length === asked.filter(Boolean).length) {
    return NextResponse.json(
      {
        success: false,
        timed_out: timedOut,
        failed,
        error: timedOut ? 'Related lookup timed out' : 'Query failed',
      },
      { status: timedOut ? 504 : 500 }
    )
  }

  return NextResponse.json({
    success: true,
    by_email:    rows.by_email,
    by_domain:   rows.by_domain,
    by_password: rows.by_password,
    failed,
    timed_out:   timedOut,
  })
}
