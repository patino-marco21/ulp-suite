import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import { isMvReady } from "@/lib/mv-ready"

export const dynamic = 'force-dynamic'

// GET /api/reuse?page=1&limit=50&email=&password=
// Returns email:password pairs that appear across more than one domain.
// Uses ulp.reuse_pairs MV (AggregatingMergeTree) when warm;
// falls back to direct full-scan of ulp.credentials during backfill.
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const page        = Math.max(1, parseInt(searchParams.get('page')     || '1',  10))
  const limit       = Math.min(100, Math.max(10, parseInt(searchParams.get('limit') || '50', 10)))
  const offset      = (page - 1) * limit
  const emailFilter = (searchParams.get('email')    || '').trim().toLowerCase()
  const pwFilter    = (searchParams.get('password') || '').trim()

  try {
    const ready = await isMvReady('reuse', 'ulp.reuse_pairs')

    if (!ready) {
      // ── Fallback: full scan of credentials (no MV data yet) ───────────────
      const whereParts: string[] = [`login_type = 'email'`, `length(password) > 0`]
      const queryParams: Record<string, unknown> = { limit, offset }

      if (emailFilter) {
        whereParts.push(`position(lower(email), {emailFilter:String}) > 0`)
        queryParams.emailFilter = emailFilter
      }
      if (pwFilter) {
        whereParts.push(`position(password, {pwFilter:String}) > 0`)
        queryParams.pwFilter = pwFilter
      }

      const BASE_WHERE = whereParts.join(' AND ')

      const rows = await executeQuery(`
        SELECT
          email,
          password,
          uniq(domain)           AS domain_count,
          groupUniqArray(domain) AS domains
        FROM ulp.credentials
        WHERE ${BASE_WHERE}
        GROUP BY email, password
        HAVING domain_count > 1
        ORDER BY domain_count DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break',
                 use_query_cache = 0
      `, queryParams)

      const countParams: Record<string, unknown> = {}
      if (emailFilter) countParams.emailFilter = emailFilter
      if (pwFilter)    countParams.pwFilter    = pwFilter

      const countResult = await executeQuery(`
        SELECT count() AS total
        FROM (
          SELECT email, password
          FROM ulp.credentials
          WHERE ${BASE_WHERE}
          GROUP BY email, password
          HAVING uniq(domain) > 1
        )
        SETTINGS max_execution_time = 120, timeout_overflow_mode = 'break',
                 use_query_cache = 0
      `, countParams)

      const total = Number((countResult as any[])[0]?.total || 0)
      return NextResponse.json({
        success: true,
        results: rows,
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
      })
    }

    // ── MV path: two-query pattern ────────────────────────────────────────
    // Build WHERE for the MV table. login_type='email' and length(password)>0
    // are implicit (the MV only ever stored those rows); only optional user
    // filters remain.
    const mvWhereParts: string[] = []
    if (emailFilter) mvWhereParts.push(`position(lower(email), {emailFilter:String}) > 0`)
    if (pwFilter)    mvWhereParts.push(`position(password, {pwFilter:String}) > 0`)
    const mvWhere = mvWhereParts.length ? `WHERE ${mvWhereParts.join(' AND ')}` : ''

    const mvQueryParams: Record<string, unknown> = { limit, offset }
    if (emailFilter) mvQueryParams.emailFilter = emailFilter
    if (pwFilter)    mvQueryParams.pwFilter    = pwFilter

    const mvCountParams: Record<string, unknown> = {}
    if (emailFilter) mvCountParams.emailFilter = emailFilter
    if (pwFilter)    mvCountParams.pwFilter    = pwFilter

    // Query 1 (paginated list) + count run in parallel
    const [mvRows, countResult] = await Promise.all([
      executeQuery(`
        SELECT email, password, uniqMerge(domain_hll) AS domain_count
        FROM ulp.reuse_pairs
        ${mvWhere}
        GROUP BY email, password
        HAVING domain_count > 1
        ORDER BY domain_count DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw',
                 use_query_cache = 1, query_cache_ttl = 120
      `, mvQueryParams),
      executeQuery(`
        SELECT count() AS total
        FROM (
          SELECT email, password
          FROM ulp.reuse_pairs
          ${mvWhere}
          GROUP BY email, password
          HAVING uniqMerge(domain_hll) > 1
        )
        SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw',
                 use_query_cache = 1, query_cache_ttl = 120
      `, mvCountParams),
    ])

    // Query 2 — domain samples for current page (serial: depends on Query 1 rows)
    // Fetches up to 8 sample domains per pair from ulp.credentials.
    // Uses the email bloom_filter index for fast granule pruning.
    const domainsMap = new Map<string, string[]>()
    if ((mvRows as any[]).length > 0) {
      const pairParams: Record<string, string> = {}
      const pairList = (mvRows as any[]).map((r, i) => {
        pairParams[`e${i}`] = String(r.email)
        pairParams[`p${i}`] = String(r.password)
        return `({e${i}:String}, {p${i}:String})`
      }).join(', ')

      const domainRows = await executeQuery(`
        SELECT email, password, groupUniqArray(8)(domain) AS domains
        FROM ulp.credentials
        WHERE (email, password) IN (${pairList})
          AND login_type = 'email'
        GROUP BY email, password
        SETTINGS max_execution_time = 10
      `, pairParams) as Array<{ email: string; password: string; domains: string[] }>

      for (const r of domainRows) {
        domainsMap.set(`${r.email}\0${r.password}`, r.domains)
      }
    }

    const total = Number((countResult as any[])[0]?.total || 0)
    const results = (mvRows as any[]).map(r => ({
      email:        String(r.email),
      password:     String(r.password),
      domain_count: Number(r.domain_count),
      domains:      domainsMap.get(`${r.email}\0${r.password}`) || [],
    }))

    return NextResponse.json({
      success: true,
      results,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    })
  } catch (error) {
    console.error('Reuse query error:', error)
    return NextResponse.json({ success: false, error: 'Reuse query failed' }, { status: 500 })
  }
}
