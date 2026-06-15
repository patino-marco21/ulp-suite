/**
 * POST /api/admin/parse-sample
 *
 * Flywheel diagnostic endpoint — paste raw credential lines and get back
 * a per-line parse result with rejection reasons, a summary breakdown,
 * and recommendations for improving the parser.
 *
 * Useful for diagnosing why a file has a low import rate before uploading it.
 *
 * Body: plain text (raw lines, up to 10,000 lines / ~1 MB)
 * Returns: { lines: ParseLineResult[], summary, recommendations }
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, isAdmin } from '@/lib/auth'
import {
  parseLine, makeRejectionMap,
  type RejectionReason,
} from '@/lib/ulp-parser'
import { REASON_LABELS, buildRecommendations, buildTopRejections } from '@/lib/parse-sample-report'

export const dynamic = 'force-dynamic'

const MAX_LINES   = 10_000
const MAX_BYTES   = 1_024 * 1_024  // 1 MB

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ success: false, error: 'Admin access required' }, { status: 403 })
  }

  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > MAX_BYTES) {
    return NextResponse.json(
      { success: false, error: `Body exceeds 1 MB limit (${contentLength} bytes)` },
      { status: 413 }
    )
  }

  const body = await request.text()
  const rawLines = body.split(/\r?\n/).slice(0, MAX_LINES)

  const breakdown = makeRejectionMap()
  let parsed   = 0

  const lineResults: Array<{
    line: number; raw: string; ok: boolean;
    cred?: { url: string; email: string; password: string; domain: string };
    reason?: RejectionReason | string; label?: string;
  }> = []

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx]
    const raw  = line.substring(0, 120)

    const { credential: cred, reason } = parseLine(line, '_sample_')
    if (cred) {
      parsed++
      lineResults.push({ line: idx + 1, raw, ok: true, cred: { url: cred.url, email: cred.email, password: cred.password, domain: cred.domain } })
    } else {
      const r = reason ?? 'no_fields'
      if (r in breakdown) (breakdown as Record<string, number>)[r]++
      lineResults.push({ line: idx + 1, raw, ok: false, reason: r, label: REASON_LABELS[r] ?? r })
    }
  }

  const total   = rawLines.length
  const skipped = total - parsed
  const importPct = total > 0 ? Math.round(parsed / total * 1000) / 10 : 0

  // Build recommendations from the breakdown + import rate (see parse-sample-report)
  const recommendations = buildRecommendations(breakdown, total, importPct)

  // Top rejection reasons sorted by count (see parse-sample-report)
  const topRejections = buildTopRejections(breakdown, total)

  return NextResponse.json({
    success: true,
    summary: {
      total_lines:  total,
      parsed,
      skipped,
      import_pct:   importPct,
    },
    top_rejections: topRejections,
    recommendations,
    // Only return per-line detail for small samples (≤500 lines)
    lines: total <= 500 ? lineResults : undefined,
    note:  total > 500
      ? `Per-line results omitted (${total} lines > 500 limit). Use ≤500 lines for per-line detail.`
      : undefined,
  })
}
