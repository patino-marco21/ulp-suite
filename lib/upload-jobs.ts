/**
 * In-process upload job store.
 *
 * Stores running/completed upload jobs so the SSE endpoint can push
 * progress events to the browser. Jobs expire after 10 minutes.
 *
 * Note: single-process only. Works for self-hosted Next.js.
 */

export type JobStatus = 'running' | 'done' | 'error'

export interface UploadJob {
  id:          string
  status:      JobStatus
  imported:    number
  skipped:     number
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
    total_lines: totalLines,
    breach_name: breachName,
    started_at:  Date.now(),
    rejection_breakdown: { blank: 0, no_fields: 0, no_password: 0 },
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
  const pct     = job.total_lines > 0
    ? Math.min(100, Math.round((job.imported / job.total_lines) * 100))
    : 0
  const elapsed = Date.now() - job.started_at
  const payload = JSON.stringify({
    imported:            job.imported,
    skipped:             job.skipped,
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
