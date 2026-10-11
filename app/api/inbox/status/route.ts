import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { dbQuery } from '@/lib/sqlite'
import { uploadQueue, getCurrentJob } from '@/lib/upload-queue'
import { getWaiting, getFailed, getDoneCount } from '@/lib/inbox-helpers'
import { getInboxJobProgress, getInFlightCount } from '@/lib/inbox-watcher'
import { progressRows } from '@/lib/inbox-progress'

export const dynamic = 'force-dynamic'

interface DoneRow {
  id:            number
  filename:      string
  status:        string
  imported:      number
  known:         number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const current    = getCurrentJob()
  const depth      = uploadQueue.activeCount + uploadQueue.pendingCount
  const progress   = getInboxJobProgress()

  // Exclude the file currently being processed from the waiting list —
  // it is in inbox/ (not yet moved to done/) but is not truly waiting.
  const allWaiting = getWaiting()
  const waiting    = current ? allWaiting.filter(f => f.name !== current) : allWaiting

  const failed     = getFailed()
  const done_count = getDoneCount()

  const done_recent = dbQuery(
    `SELECT id, filename, status, imported, known, skipped, duration_ms, error_message, created_at
     FROM processing_jobs
     WHERE source = 'inbox'
     ORDER BY id DESC
     LIMIT 10`,
  ) as DoneRow[]

  // Build enriched progress object with ETA if we have enough data. With novelty-aware ingest the rows read and staged measure
  // progress (the rows written stay near zero for most of a file); otherwise the rows written do.
  const phaseFields = progress
    ? {
        rows_staged: progress.rows_staged ?? 0,
        rows_known:  progress.rows_known ?? 0,
        phase:       progress.phase ?? null,
        slab:        progress.slab ?? null,
        slabs:       progress.slabs ?? null,
      }
    : null
  const rowsDone = progress ? progressRows(progress) : 0
  let current_progress = null
  if (progress && rowsDone > 0) {
    const elapsed_ms     = Date.now() - progress.started_at
    const rows_per_sec   = Math.round(rowsDone / (elapsed_ms / 1_000))
    // Estimate total rows from file size (avg credential line ≈ 80 bytes)
    const est_total_rows = progress.file_size_bytes > 0
      ? Math.round(progress.file_size_bytes / 80)
      : null
    const pct = est_total_rows && est_total_rows > 0
      ? Math.min(99, Math.round(rowsDone / est_total_rows * 100))
      : null
    const eta_ms = est_total_rows && rows_per_sec > 0
      ? Math.round((est_total_rows - rowsDone) / rows_per_sec * 1_000)
      : null

    current_progress = {
      filename:         progress.filename,
      started_at:       progress.started_at,
      elapsed_ms,
      rows_imported:    progress.rows_imported,
      ...phaseFields,
      file_size_bytes:  progress.file_size_bytes,
      rows_per_sec,
      est_total_rows,
      pct,
      eta_ms,
    }
  } else if (progress) {
    // Processing started but no rows yet (parsing/first batch)
    current_progress = {
      filename:         progress.filename,
      started_at:       progress.started_at,
      elapsed_ms:       Date.now() - progress.started_at,
      rows_imported:    progress.rows_imported,
      ...phaseFields,
      file_size_bytes:  progress.file_size_bytes,
      rows_per_sec:     0,
      est_total_rows:   null,
      pct:              null,
      eta_ms:           null,
    }
  }

  const in_flight_count = getInFlightCount()
  // "stuck" = files in inbox/ but NOT in inFlight (reconcile missed them)
  // OR files IN inFlight but NOT the current job AND not moving → stale entries
  const stale_in_flight = Math.max(0, in_flight_count - (current ? 1 : 0))

  return NextResponse.json({
    watcher_active:   depth > 0 || current !== null,
    current_file:     current,
    queue_depth:      depth,
    current_progress,
    waiting,
    waiting_total:    allWaiting.length,   // includes the file being processed
    in_flight_count,
    stale_in_flight,  // > 0 means files may be stuck — use Force Scan to recover
    failed,
    done_count,
    done_recent,
  })
}
