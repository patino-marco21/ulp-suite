/**
 * In-process upload job store.
 *
 * Stores running/completed upload jobs so the SSE endpoint can push
 * progress events to the browser. Jobs expire after 10 minutes.
 *
 * Note: single-process only. Works for self-hosted Next.js.
 */

import { makeRejectionMap } from '@/lib/ulp-parser'
import type { ImportPhase } from '@/lib/import-runner'

export type JobStatus = 'running' | 'done' | 'error'

export interface UploadJob {
  id:          string
  status:      JobStatus
  /** Rows written. With novelty-aware ingest (lib/ingest-novelty.ts) this is NEW rows only, and stays 0 until a slab is committed. */
  imported:    number
  skipped:     number
  tierDropped: number      // rows dropped pre-insert by the ingest tier filter
  /** Distinct credentials of the file that the table already held (novelty-aware ingest; 0 on the direct path). */
  known:            number
  /** Rows that repeat an earlier row of the same file (novelty-aware ingest; the direct path counts them in `skipped`). */
  inFileDuplicates: number
  /** Rows parsed and staged so far (novelty-aware ingest). */
  staged:      number
  /** Set while novelty-aware ingest is working; cleared when the job ends. Absent on the direct path. */
  phase?:      ImportPhase
  slab?:       number
  slabs?:      number
  total_lines: number      // estimated from file size / 60 bytes per line
  breach_name: string
  started_at:  number      // Date.now()
  rejection_breakdown: Record<string, number>
  error?:      string
  // SSE writer — set by the progress endpoint, written to by the upload pipeline
  writer?:     WritableStreamDefaultWriter<Uint8Array>
}

const jobs = new Map<string, UploadJob>()

/** Create a new job and return it. */
export function createJob(id: string, totalLines: number, breachName: string): UploadJob {
  const job: UploadJob = {
    id,
    status:      'running',
    imported:    0,
    skipped:     0,
    tierDropped: 0,
    known:            0,
    inFileDuplicates: 0,
    staged:      0,
    total_lines: totalLines,
    breach_name: breachName,
    started_at:  Date.now(),
    rejection_breakdown: makeRejectionMap(),
  }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): UploadJob | undefined {
  return jobs.get(id)
}

export function updateJob(id: string, patch: Partial<UploadJob>): void {
  const job = jobs.get(id)
  if (job) Object.assign(job, patch)
}

/** Push an SSE event to the job's connected browser, if any. */
export async function pushEvent(job: UploadJob): Promise<void> {
  if (!job.writer) return
  // While novelty-aware ingest is working, progress is the rows read and staged; on the direct path it is the rows inserted.
  const rowsDone = job.phase ? job.staged : job.imported
  const pct     = job.total_lines > 0
    ? Math.min(100, Math.round((rowsDone / job.total_lines) * 100))
    : 0
  const elapsed = Date.now() - job.started_at
  const payload = JSON.stringify({
    imported:            job.imported,
    skipped:             job.skipped,
    tierDropped:         job.tierDropped,
    known:               job.known,
    inFileDuplicates:    job.inFileDuplicates,
    staged:              job.staged,
    phase:               job.phase,
    slab:                job.slab,
    slabs:               job.slabs,
    pct,
    elapsed_ms:          elapsed,
    status:              job.status,
    rejection_breakdown: job.status === 'done' ? job.rejection_breakdown : undefined,
    error:               job.error,
  })
  try {
    const enc = new TextEncoder()
    await job.writer.write(enc.encode(`data: ${payload}\n\n`))
    if (job.status === 'done' || job.status === 'error') {
      await job.writer.close()
      job.writer = undefined
    }
  } catch {
    // Client disconnected — ignore
    job.writer = undefined
  }
}

// GC expired jobs every 5 minutes (keep for 10 minutes after completion)
const GC_INTERVAL_MS  = 5 * 60 * 1000
const JOB_TTL_MS      = 10 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - job.started_at > JOB_TTL_MS) {
      jobs.delete(id)
    }
  }
}, GC_INTERVAL_MS)
