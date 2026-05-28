import { type NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { dbGet, dbRun } from "@/lib/sqlite"
import { parseBreachRow } from "@/lib/breach-matcher"
import { executeQuery } from "@/lib/clickhouse"

export const dynamic = 'force-dynamic'

// GET /api/breaches/[name]
// Returns breach metadata + ClickHouse stats (credential count, top domains, sources).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const { name } = await params
  const breachName = decodeURIComponent(name)
  const row = dbGet(`SELECT * FROM breaches WHERE breach_name = ?`, [breachName]) as Record<string, unknown> | undefined
  if (!row) return NextResponse.json({ success: false, error: "Breach not found" }, { status: 404 })

  const breach = parseBreachRow(row)

  // Enrich with live ClickHouse stats
  let stats: {
    credential_count: number
    unique_emails: number
    unique_domains: number
    source_files: string[]
  } = { credential_count: 0, unique_emails: 0, unique_domains: 0, source_files: [] }

  try {
    const [countRows, sourceRows] = await Promise.all([
      executeQuery(
        `SELECT count() AS cnt, uniq(email) AS emails, uniq(domain) AS domains
         FROM ulp.credentials WHERE breach_name = {b:String}`,
        { b: breachName }
      ),
      executeQuery(
        `SELECT DISTINCT source_file FROM ulp.credentials WHERE breach_name = {b:String} LIMIT 100`,
        { b: breachName }
      ),
    ])
    stats = {
      credential_count: Number(countRows[0]?.cnt || 0),
      unique_emails: Number(countRows[0]?.emails || 0),
      unique_domains: Number(countRows[0]?.domains || 0),
      source_files: (sourceRows as Array<{ source_file: string }>).map(r => r.source_file),
    }
  } catch { /* ClickHouse unavailable or column not yet present */ }

  return NextResponse.json({ success: true, breach, stats })
}

// PATCH /api/breaches/[name]
// Update breach metadata fields.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { name } = await params
  const breachName = decodeURIComponent(name)
  const existing = dbGet(`SELECT id FROM breaches WHERE breach_name = ?`, [breachName])
  if (!existing) return NextResponse.json({ success: false, error: "Breach not found" }, { status: 404 })

  const body = await request.json()
  const allowed = [
    'title', 'domain', 'breach_date', 'pwn_count', 'description',
    'logo_path', 'is_verified', 'is_fabricated', 'is_sensitive',
    'is_spam_list', 'is_malware', 'is_stealer_log', 'is_mega_dump',
    'source_file_patterns',
  ]

  const parts: string[] = []
  const vals: unknown[] = []

  for (const key of allowed) {
    if (!(key in body)) continue
    const v = body[key]
    if (key === 'source_file_patterns') {
      parts.push(`${key} = ?`)
      vals.push(JSON.stringify(Array.isArray(v) ? v : []))
    } else if (typeof v === 'boolean') {
      parts.push(`${key} = ?`)
      vals.push(v ? 1 : 0)
    } else {
      parts.push(`${key} = ?`)
      vals.push(v)
    }
  }

  if (parts.length === 0) {
    return NextResponse.json({ success: false, error: 'No valid fields to update' }, { status: 400 })
  }

  parts.push(`updated_at = datetime('now')`)
  vals.push(breachName)
  dbRun(`UPDATE breaches SET ${parts.join(', ')} WHERE breach_name = ?`, vals)

  const updated = dbGet(`SELECT * FROM breaches WHERE breach_name = ?`, [breachName]) as Record<string, unknown>
  return NextResponse.json({ success: true, breach: parseBreachRow(updated) })
}

// DELETE /api/breaches/[name]
// Removes breach record from SQLite (does NOT alter ClickHouse credentials).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { name } = await params
  const breachName = decodeURIComponent(name)
  const existing = dbGet(`SELECT id FROM breaches WHERE breach_name = ?`, [breachName])
  if (!existing) return NextResponse.json({ success: false, error: "Breach not found" }, { status: 404 })

  dbRun(`DELETE FROM breaches WHERE breach_name = ?`, [breachName])
  dbRun(`DELETE FROM source_breach_map WHERE breach_name = ?`, [breachName])

  return NextResponse.json({ success: true })
}
