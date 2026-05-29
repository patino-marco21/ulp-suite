/**
 * POST /api/inbox/scan
 *
 * Force an immediate reconciliation of the inbox folder.
 *
 * Use this when files are stuck in "Waiting" and nothing is processing.
 * Common cause: files were moved out of inbox/ and back in while still in
 * the inFlight set, so the normal reconcile loop skips them.
 *
 * This endpoint:
 *   1. Clears all inFlight entries that are not currently being processed
 *   2. Triggers an immediate reconcile scan
 *   3. Returns counts of cleared + newly queued files
 */

import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { clearStaleInFlight, forceReconcile, getInFlightCount } from '@/lib/inbox-watcher'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const cleared = clearStaleInFlight()
  const queued  = forceReconcile()

  return NextResponse.json({
    success:      true,
    cleared,
    queued,
    in_flight:    getInFlightCount(),
    message:      queued > 0
      ? `Cleared ${cleared} stale entries, queued ${queued} file(s) for processing.`
      : cleared > 0
        ? `Cleared ${cleared} stale entries. No files found in inbox/ to queue.`
        : 'No stale entries found. All files in inbox/ are already queued or processing.',
  })
}
