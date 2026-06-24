/**
 * Pure, shared reporting helpers for parser rejection breakdowns —
 * rejection-reason labels, the top-rejections table, and recommendation rules.
 *
 * Single source of truth consumed by both the /api/admin/parse-sample diagnostic
 * endpoint and the upload UI's "why lines were skipped" panel, so labels stay
 * consistent. Data-only, so it's unit-testable without an HTTP/auth harness and
 * safe to import from a client component (the only ulp-parser dependency is a
 * type-only import, erased at build). Covers every RejectionReason the parser
 * can emit, including `garbage` (the largest reject class after the 2026-06
 * junk-rejection work) and `dedup`.
 */

import type { RejectionReason } from '@/lib/ulp-parser'

/** Human-readable explanation for each rejection reason. */
export const REASON_LABELS: Record<string, string> = {
  blank:       'Empty / comment / section-header line',
  no_fields:   'Cannot split into ≥2 fields',
  no_password: 'Login found but no valid password (too short or equals login)',
  dedup:       'Duplicate of an earlier line in this sample',
  garbage:     'Non-credential: placeholder login, "no password" sentinel, token/decryption blob, or binary/mojibake',
  tier_dropped: 'Hard-dropped country tier (e.g. T3) — rejected at parse time before any further work',
}

export interface TopRejection {
  reason: string
  count:  number
  pct:    number
  label:  string
}

/** Top non-zero rejection reasons, sorted by count desc, capped at 8, labeled. */
export function buildTopRejections(
  breakdown: Record<string, number>,
  total: number,
): TopRejection[] {
  return (Object.entries(breakdown) as [string, number][])
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([reason, count]) => ({
      reason,
      count,
      pct:   total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
      label: REASON_LABELS[reason] ?? reason,
    }))
}

interface Rec { reason: RejectionReason; threshold: number; message: string }

const RECS: Rec[] = [
  {
    reason:    'no_fields',
    threshold: 10,
    message:   'Many lines cannot be split. Check for unusual separators (pipe, space) or binary/compressed data mixed into the text file.',
  },
  {
    reason:    'no_password',
    threshold: 5,
    message:   'Many lines have no valid password. Passwords must be ≥3 characters and differ from the login.',
  },
  {
    reason:    'garbage',
    threshold: 10,
    message:   'Many lines are non-credentials — placeholder logins (Password/N/A/UNKNOWN), "no password" sentinels ([NOT_SAVED], *none*), token/decryption blobs, or binary/mojibake. These are correctly dropped; if unexpectedly high the file may not be a clean credential list (e.g. a browser DB dump or non-credential export).',
  },
]

/**
 * Human-readable recommendations from the rejection breakdown + import rate.
 * A reason-specific tip fires when its share of total lines crosses its
 * threshold; a low-import-rate caution and a healthy-rate note round it out.
 */
export function buildRecommendations(
  breakdown: Record<string, number>,
  total: number,
  importPct: number,
): string[] {
  const recommendations: string[] = []
  for (const rec of RECS) {
    const count = breakdown[rec.reason] ?? 0
    const pct   = total > 0 ? (count / total) * 100 : 0
    if (pct >= rec.threshold) {
      recommendations.push(`[${rec.reason}] ${Math.round(pct)}% of lines: ${rec.message}`)
    }
  }
  if (importPct < 50 && recommendations.length === 0) {
    recommendations.push('Import rate is below 50%. Check that the file is a valid ULP/credential text file and not binary/compressed data.')
  }
  if (importPct >= 80) {
    recommendations.push('Import rate looks healthy (≥80%). The parser is handling this file format well.')
  }
  return recommendations
}
