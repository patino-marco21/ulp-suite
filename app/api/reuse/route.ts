import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"

export const dynamic = 'force-dynamic'

// GET /api/reuse?page=1&limit=50
// Returns email:password pairs that appear across more than one domain.
// These are the highest-value credential stuffing targets.
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const page        = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit       = Math.min(100, Math.max(10, parseInt(searchParams.get('limit') || '50', 10)))
  const offset      = (page - 1) * limit
  const emailFilter = (searchParams.get('email') || '').trim().toLowerCase()
  const pwFilter    = (searchParams.get('password') || '').trim()

  try {
    // Filter to real email logins only — telegram links / usernames in the email
    // field would otherwise dominate the results as false positives.
    const whereParts: string[] = [`login_type = 'email'`, `length(password) > 0`]
    const queryParams: Record<string, unknown> = { limit, offset }

    if (emailFilter) {
      // position() is a substring search; fine given ClickHouse's vectorised engine
      whereParts.push(`position(lower(email), {emailFilter:String}) > 0`)
      queryParams.emailFilter = emailFilter
    }
    if (pwFilter) {
      whereParts.push(`position(password, {pwFilter:String}) > 0`)
      queryParams.pwFilter = pwFilter
    }

    const BASE_WHERE = whereParts.join(' AND ')

    // groupUniqArray collects distinct domains per email:password pair
    const rows = await executeQuery(`
      SELECT
        email,
        password,
        uniq(domain) AS domain_count,
        groupUniqArray(domain)  AS domains
      FROM ulp.credentials
      WHERE ${BASE_WHERE}
      GROUP BY email, password
      HAVING domain_count > 1
      ORDER BY domain_count DESC
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
      SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break'
    `, queryParams)

    // Total count via subquery
    const countResult = await executeQuery(`
      SELECT count() AS total
      FROM (
        SELECT email, password
        FROM ulp.credentials
        WHERE ${BASE_WHERE}
        GROUP BY email, password
        HAVING uniq(domain) > 1
      )
      SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break'
    `, { emailFilter: emailFilter || '', pwFilter: pwFilter || '' })

    const total = Number(countResult[0]?.total || 0)

    return NextResponse.json({
      success: true,
      results: rows,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    })
  } catch (error) {
    console.error('Reuse query error:', error)
    return NextResponse.json({ success: false, error: 'Reuse query failed' }, { status: 500 })
  }
}
