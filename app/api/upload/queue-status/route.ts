import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { dbQuery } from '@/lib/sqlite'
import { uploadQueue, getCurrentJob } from '@/lib/upload-queue'

export const dynamic = 'force-dynamic'

interface ProcessingJobRow {
  id:            number
  source:        string
  filename:      string
  status:        string
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  breach_name:   string | null
  created_at:    string
}

interface TotalsRow {
  status:         string
  file_count:     number
  total_imported: number
  total_skipped:  number
}

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const recent = dbQuery(
    `SELECT id, source, filename, status, imported, skipped,
            duration_ms, error_message, breach_name, created_at
     FROM processing_jobs
     ORDER BY id DESC
     LIMIT 20`,
  ) as ProcessingJobRow[]

  const totalsRows = dbQuery(
    `SELECT status,
            COUNT(*)          AS file_count,
            SUM(imported)     AS total_imported,
            SUM(skipped)      AS total_skipped
     FROM processing_jobs
     GROUP BY status`,
  ) as TotalsRow[]

  const done   = totalsRows.find(r => r.status === 'done')
  const failed = totalsRows.find(r => r.status === 'failed')

  return NextResponse.json({
    queue: {
      active:       uploadQueue.activeCount,
      pending:      uploadQueue.pendingCount,
      current_file: getCurrentJob(),
    },
    recent,
    totals: {
      files_done:    done?.file_count    ?? 0,
      files_failed:  failed?.file_count  ?? 0,
      rows_imported: done?.total_imported ?? 0,
      rows_skipped:  done?.total_skipped  ?? 0,
    },
  })
}
