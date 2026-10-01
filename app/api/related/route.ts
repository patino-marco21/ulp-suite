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
 */
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

  try {
    const [byEmail, byDomain, byPassword] = await Promise.all([
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

    return NextResponse.json({
      success: true,
      by_email:    byEmail,
      by_domain:   byDomain,
      by_password: byPassword,
    })
  } catch (error) {
    console.error('Related query error:', error)
    return NextResponse.json({ success: false, error: 'Query failed' }, { status: 500 })
  }
}
