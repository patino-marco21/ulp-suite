import { type NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { dbQuery, dbGet, dbRun } from "@/lib/sqlite"
import { parseBreachRow } from "@/lib/breach-matcher"
import { executeQuery } from "@/lib/clickhouse"

export const dynamic = 'force-dynamic'

// GET /api/breaches?page=1&limit=50&q=linkedin
// Returns all breach records with credential counts from ClickHouse.
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const sp = new URL(request.url).searchParams
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
  const limit = Math.min(200, Math.max(10, parseInt(sp.get('limit') || '50', 10)))
  const offset = (page - 1) * limit
  const q = sp.get('q') || ''

  const searchClause = q ? `WHERE breach_name LIKE ? OR title LIKE ?` : ''
  const searchParams = q ? [`%${q}%`, `%${q}%`] : []

  const total = (dbGet(`SELECT COUNT(*) as c FROM breaches ${searchClause}`, searchParams) as { c: number }).c
  const rows = dbQuery(
    `SELECT * FROM breaches ${searchClause} ORDER BY pwn_count DESC, title ASC LIMIT ? OFFSET ?`,
    [...searchParams, limit, offset]
  ) as Record<string, unknown>[]

  const breaches = rows.map(parseBreachRow)

  // Fetch per-breach credential counts from ClickHouse in one query
  let countMap: Record<string, number> = {}
  if (breaches.length > 0) {
    try {
      const names = breaches.map(b => b.breach_name)
      const countRows = await executeQuery(`
        SELECT breach_name, count() AS cnt
        FROM ulp.credentials
        WHERE breach_name IN ({names:Array(String)})
        GROUP BY breach_name
      `, { names }) as Array<{ breach_name: string; cnt: string }>
      countMap = Object.fromEntries(countRows.map(r => [r.breach_name, Number(r.cnt)]))
    } catch { /* ClickHouse may not have column yet — skip counts */ }
  }

  return NextResponse.json({
    success: true,
    breaches: breaches.map(b => ({ ...b, credential_count: countMap[b.breach_name] ?? 0 })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  })
}

// POST /api/breaches — create a new breach record manually
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const {
    breach_name,
    title,
    domain = '',
    breach_date = '',
    pwn_count = 0,
    description = '',
    logo_path = '',
    data_classes = [],
    is_verified = false,
    is_fabricated = false,
    is_sensitive = false,
    is_spam_list = false,
    is_malware = false,
    is_stealer_log = false,
    is_mega_dump = false,
    source_file_patterns = [],
  } = body

  if (!breach_name?.trim() || !title?.trim()) {
    return NextResponse.json({ success: false, error: 'breach_name and title are required' }, { status: 400 })
  }

  const existing = dbGet(`SELECT id FROM breaches WHERE breach_name = ?`, [breach_name])
  if (existing) {
    return NextResponse.json({ success: false, error: 'Breach name already exists' }, { status: 409 })
  }

  const { lastId } = dbRun(
    `INSERT INTO breaches
       (breach_name, title, domain, breach_date, pwn_count, description, logo_path,
        data_classes, is_verified, is_fabricated, is_sensitive, is_spam_list,
        is_malware, is_stealer_log, is_mega_dump, source_file_patterns)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      breach_name.trim(), title.trim(), domain, breach_date, pwn_count,
      description, logo_path,
      JSON.stringify(data_classes),
      is_verified ? 1 : 0, is_fabricated ? 1 : 0, is_sensitive ? 1 : 0,
      is_spam_list ? 1 : 0, is_malware ? 1 : 0, is_stealer_log ? 1 : 0,
      is_mega_dump ? 1 : 0, JSON.stringify(source_file_patterns),
    ]
  )

  const newBreach = dbGet(`SELECT * FROM breaches WHERE id = ?`, [lastId]) as Record<string, unknown>
  return NextResponse.json({ success: true, breach: parseBreachRow(newBreach) }, { status: 201 })
}
