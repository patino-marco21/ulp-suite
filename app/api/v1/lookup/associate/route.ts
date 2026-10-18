/**
 * Login association API v1
 * POST /api/v1/lookup/associate   { "login": "name", "site": "example.com", "password": "...", "want": "email" }
 *                                 { "items": [ { "login": ... }, ... ] }     (up to 10 logins)
 *
 * Which other logins (e-mail by default, or username / phone with "want") belong to the same account as a login: the account's own password, on the
 * site the login is known from (optional "site") and anywhere else, is the identity; the handle alone is weak evidence. Every candidate comes with
 * a confidence (high / medium / low) and the evidence behind it. Heuristics, not proof. Design, signals and measurements:
 * docs/superpowers/specs/2026-10-18-login-association-design.md and lib/login-association.ts. A login takes a few seconds; up to three are probed at once.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withApiKeyAuth, addRateLimitHeaders, logApiRequest } from '@/lib/api-key-auth'
import { executeQuery } from '@/lib/clickhouse'
import { ASSOCIATE_LIMITS, associateLogin, parseAssociateItem, type AssociateItem, type AssociateResult } from '@/lib/login-association'

export const dynamic = 'force-dynamic'

const CONCURRENCY = 3

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

const toJson = (r: AssociateResult) => ({
  login: r.login,
  want: r.want,
  anchored: r.anchored,
  too_common: r.tooCommon,
  login_sites: r.loginSites,
  candidates_total: r.candidatesTotal,
  candidates: r.candidates,
  errors: r.errors,
})

export async function POST(request: NextRequest) {
  const authResult = await withApiKeyAuth(request, ['admin', 'analyst'])
  if (!authResult.success) {
    return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status || 401 })
  }

  await logApiRequest(authResult.apiKey!, request, 'v1/lookup/associate')

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'The request body must be valid JSON' }, { status: 400 })
  }

  const raw: unknown[] = typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [body]
  if (raw.length === 0) return NextResponse.json({ success: false, error: 'items must not be empty' }, { status: 400 })
  if (raw.length > ASSOCIATE_LIMITS.maxItems) {
    return NextResponse.json({ success: false, error: `At most ${ASSOCIATE_LIMITS.maxItems} logins per request` }, { status: 400 })
  }
  const items: AssociateItem[] = []
  for (const [i, r] of raw.entries()) {
    const parsed = parseAssociateItem(r)
    if (!parsed.ok) return NextResponse.json({ success: false, error: `item ${i + 1}: ${parsed.error}` }, { status: 400 })
    items.push(parsed.item)
  }

  const results = await mapPool(items, CONCURRENCY, item => associateLogin(item, (sql, params) => executeQuery(sql, params)))

  // Every login failed because ClickHouse could not be reached: say so instead of returning a list of empty answers.
  if (results.every(r => r.candidates.length === 0 && r.errors.length > 0 && r.errors.every(e => e.endsWith('connection failed')))) {
    return NextResponse.json({ success: false, error: 'ClickHouse is not reachable' }, { status: 503 })
  }

  return addRateLimitHeaders(NextResponse.json({ success: true, count: results.length, results: results.map(toJson) }), authResult.rateLimit)
}
