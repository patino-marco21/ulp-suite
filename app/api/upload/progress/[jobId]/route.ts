/**
 * GET /api/upload/progress/:jobId
 *
 * Server-Sent Events stream for upload progress.
 * Uses TransformStream so the Response is returned immediately while
 * the upload pipeline pushes events via the writer stored on the job.
 *
 * Next.js App Router buffers responses until the handler returns, so
 * we must return the readable side immediately and write asynchronously.
 */
import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { getJob, pushEvent } from "@/lib/upload-jobs"

export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const { jobId } = await params
  const job = getJob(jobId)

  if (!job) {
    return NextResponse.json({ success: false, error: "Job not found" }, { status: 404 })
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  // Store writer on the job so the upload pipeline can push events
  job.writer = writer

  // If the job is already done (client reconnected after completion), push final state and close
  if (job.status === 'done' || job.status === 'error') {
    pushEvent(job).catch(() => {})
  }

  return new Response(readable, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx buffering for SSE
    },
  })
}
