import { type NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { dbRun, dbGet } from "@/lib/sqlite"

export const dynamic = 'force-dynamic'

// HIBP breach API response shape
interface HibpBreach {
  Name: string
  Title: string
  Domain: string
  BreachDate: string
  AddedDate: string
  ModifiedDate: string
  PwnCount: number
  Description: string
  LogoPath: string
  DataClasses: string[]
  IsVerified: boolean
  IsFabricated: boolean
  IsSensitive: boolean
  IsRetired: boolean
  IsSpamList: boolean
  IsMalware: boolean
  IsStealerLog: boolean
}

// POST /api/breaches/sync
// Fetches the HIBP public breach list and upserts all records into SQLite.
// An optional hibp-api-key header (or body field) is supported but not required
// for the public /breaches endpoint.
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const body = await request.json().catch(() => ({}))
  const apiKey = body.api_key || request.headers.get('hibp-api-key') || ''

  const headers: Record<string, string> = {
    'User-Agent': 'ULPSuite/1.0 (breach-sync)',
    'Accept': 'application/json',
  }
  if (apiKey) headers['hibp-api-key'] = apiKey

  let hibpBreaches: HibpBreach[]
  try {
    const res = await fetch('https://haveibeenpwned.com/api/v3/breaches', {
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json(
        { success: false, error: `HIBP API returned ${res.status}: ${text.substring(0, 200)}` },
        { status: 502 }
      )
    }
    hibpBreaches = await res.json()
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Failed to reach HIBP: ${err instanceof Error ? err.message : err}` },
      { status: 502 }
    )
  }

  let inserted = 0
  let updated = 0

  for (const b of hibpBreaches) {
    const existing = dbGet(`SELECT id FROM breaches WHERE breach_name = ?`, [b.Name])
    if (existing) {
      dbRun(
        `UPDATE breaches SET
           title = ?, domain = ?, breach_date = ?, pwn_count = ?,
           description = ?, logo_path = ?, data_classes = ?,
           is_verified = ?, is_fabricated = ?, is_sensitive = ?,
           is_spam_list = ?, is_malware = ?, is_stealer_log = ?,
           updated_at = datetime('now')
         WHERE breach_name = ?`,
        [
          b.Title, b.Domain, b.BreachDate, b.PwnCount,
          b.Description, b.LogoPath, JSON.stringify(b.DataClasses),
          b.IsVerified ? 1 : 0, b.IsFabricated ? 1 : 0, b.IsSensitive ? 1 : 0,
          b.IsSpamList ? 1 : 0, b.IsMalware ? 1 : 0, b.IsStealerLog ? 1 : 0,
          b.Name,
        ]
      )
      updated++
    } else {
      dbRun(
        `INSERT INTO breaches
           (breach_name, title, domain, breach_date, pwn_count, description,
            logo_path, data_classes, is_verified, is_fabricated, is_sensitive,
            is_spam_list, is_malware, is_stealer_log)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b.Name, b.Title, b.Domain, b.BreachDate, b.PwnCount,
          b.Description, b.LogoPath, JSON.stringify(b.DataClasses),
          b.IsVerified ? 1 : 0, b.IsFabricated ? 1 : 0, b.IsSensitive ? 1 : 0,
          b.IsSpamList ? 1 : 0, b.IsMalware ? 1 : 0, b.IsStealerLog ? 1 : 0,
        ]
      )
      inserted++
    }
  }

  return NextResponse.json({
    success: true,
    synced: hibpBreaches.length,
    inserted,
    updated,
  })
}
