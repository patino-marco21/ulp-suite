import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { dbQuery } from '@/lib/sqlite'
import { uploadQueue, getCurrentJob } from '@/lib/upload-queue'
import { getWaiting, getFailed, getHeld, getDoneCount } from '@/lib/inbox-helpers'
import { latestHeldReport } from '@/lib/ingest-gate-store'
import { getInboxJobsProgress, getInFlightCount, type InboxJobProgress } from '@/lib/inbox-watcher'
import { computeProgress } from '@/lib/inbox-progress'

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
  /** Rows that repeat inside the file, and why a file added nothing (lib/import-summary.ts); null on a job that did not record them. */
  repeats:       number | null
  note:          string | null
  gate_level:    string | null
  gate_note:     string | null
}

/**
 * The progress card of one file being imported. With novelty-aware ingest the rows read and staged measure progress (the rows written stay near zero for most
 * of a file); otherwise the rows written do. The share of the file read comes from the bytes the importer has read (lib/inbox-progress.ts).
 */
function progressCard(progress: InboxJobProgress, now: number) {
  const bytesRead = progress.readBytes?.()
  const view = computeProgress({
    started_at:      progress.started_at,
    file_size_bytes: progress.file_size_bytes,
    rows_imported:   progress.rows_imported,
    phase:           progress.phase,
    rows_staged:     progress.rows_staged,
    bytes_read:      bytesRead,
  }, now)
  return {
    filename:        progress.filename,
    started_at:      progress.started_at,
    elapsed_ms:      now - progress.started_at,
    rows_imported:   progress.rows_imported,
    rows_staged:     progress.rows_staged ?? 0,
    rows_known:      progress.rows_known ?? 0,
    phase:           progress.phase ?? null,
    slab:            progress.slab ?? null,
    slabs:           progress.slabs ?? null,
    file_size_bytes: progress.file_size_bytes,
    bytes_read:      bytesRead ?? null,
    ...view,
  }
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const current    = getCurrentJob()
  const depth      = uploadQueue.activeCount + uploadQueue.pendingCount

  // Exclude the file currently being processed from the waiting list —
  // it is in inbox/ (not yet moved to done/) but is not truly waiting.
  const allWaiting = getWaiting()
  const waiting    = current ? allWaiting.filter(f => f.name !== current) : allWaiting

  const failed     = getFailed()
  // Files the ingest quality gate stopped, each with the report of its hold (null when none was recorded).
  const held       = getHeld().map(f => ({ ...f, report: latestHeldReport(f.name) }))
  const done_count = getDoneCount()

  const done_recent = dbQuery(
    `SELECT id, filename, status, imported, known, skipped, duration_ms, error_message, created_at, repeats, note,
            CASE WHEN json_valid(gate_report) THEN json_extract(gate_report, '$.level') END AS gate_level,
            CASE WHEN json_valid(gate_report) THEN json_extract(gate_report, '$.reasons[0]') END AS gate_note
     FROM processing_jobs
     WHERE source = 'inbox'
     ORDER BY id DESC
     LIMIT 10`,
  ) as DoneRow[]

  // One card per file in flight: with UPLOAD_CONCURRENCY above 1 several are imported at once. current_progress stays the first of them.
  const now = Date.now()
  const jobs_progress = getInboxJobsProgress().map(p => progressCard(p, now))
  const current_progress = jobs_progress[0] ?? null

  const in_flight_count = getInFlightCount()
  // "stuck" = files in inbox/ but NOT in inFlight (reconcile missed them)
  // OR files IN inFlight but NOT the current job AND not moving → stale entries
  const stale_in_flight = Math.max(0, in_flight_count - (current ? 1 : 0))

  return NextResponse.json({
    watcher_active:   depth > 0 || current !== null,
    current_file:     current,
    queue_depth:      depth,
    current_progress,
    jobs_progress,
    waiting,
    waiting_total:    allWaiting.length,   // includes the file being processed
    in_flight_count,
    stale_in_flight,  // > 0 means files may be stuck — use Force Scan to recover
    failed,
    held,
    done_count,
    done_recent,
  })
}
