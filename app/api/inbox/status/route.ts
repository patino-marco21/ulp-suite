import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { dbQuery } from '@/lib/sqlite'
import { uploadQueue, getCurrentJob } from '@/lib/upload-queue'
import { getWaiting, getFailed, getDoneCount } from '@/lib/inbox-helpers'

export const dynamic = 'force-dynamic'

interface DoneRow {
  id:            number
  filename:      string
  status:        string
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const waiting    = getWaiting()
  const failed     = getFailed()
  const done_count = getDoneCount()
  const current    = getCurrentJob()
  const depth      = uploadQueue.activeCount + uploadQueue.pendingCount

  const done_recent = dbQuery(
    `SELECT id, filename, status, imported, skipped, duration_ms, error_message, created_at
     FROM processing_jobs
     WHERE source = 'inbox'
     ORDER BY id DESC
     LIMIT 10`,
  ) as DoneRow[]

  return NextResponse.json({
    watcher_active: depth > 0 || current !== null,
    current_file:   current,
    queue_depth:    depth,
    waiting,
    failed,
    done_count,
    done_recent,
  })
}
