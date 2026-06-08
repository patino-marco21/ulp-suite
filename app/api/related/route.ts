import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { NORM_COLS } from "@/lib/ulp-normalize"

export const dynamic = 'force-dynamic'

/**
 * GET /api/related?email=X&password=Y&domain=Z
 * Returns three buckets of related credentials:
 *   by_email    — same email address, different rows (cross-domain reuse)
 *   by_domain   — same domain, different email (exposure breadth)
 *   by_password — same password, different email (password reuse)
 *
 * Up to 25 results per bucket. All are fast point-lookups via bloom filter indexes.
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

  const SELECT = `${NORM_COLS}, breach_name, country_tier, login_type, imported_at`

  try {
    const [byEmail, byDomain, byPassword] = await Promise.all([
      // By email — all credentials sharing this login (cross-domain reuse)
      email
        ? executeQuery(
            `SELECT ${SELECT} FROM ulp.credentials
             WHERE email = {email:String}
             ORDER BY imported_at DESC LIMIT 25 SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break', use_query_cache = 0`,
            { email }
          )
        : Promise.resolve([]),

      // By domain — other logins on the same domain
      domain
        ? executeQuery(
            `SELECT ${SELECT} FROM ulp.credentials
             WHERE domain = {domain:String} AND email != {email:String}
             ORDER BY imported_at DESC LIMIT 25 SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break', use_query_cache = 0`,
            { domain, email }
          )
        : Promise.resolve([]),

      // By password — other accounts using the exact same password
      password && password.length >= 3
        ? executeQuery(
            `SELECT ${SELECT} FROM ulp.credentials
             WHERE password = {password:String} AND email != {email:String}
             ORDER BY imported_at DESC LIMIT 25 SETTINGS max_execution_time = 30, timeout_overflow_mode = 'break', use_query_cache = 0`,
            { password, email }
          )
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
