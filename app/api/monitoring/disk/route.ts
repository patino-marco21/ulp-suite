import { type NextRequest, NextResponse } from 'next/server'
import { validateRequest, requireAdminRole } from '@/lib/auth'
import { readDisk } from '@/lib/disk-watch'
import { getIngestDiskGate } from '@/lib/ingest-disk-gate'

export const dynamic = 'force-dynamic'

/** What the disk banner under the header shows: free space on the ClickHouse data disk and the ingest gate's state. */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  // readDisk never throws: an unreadable disk comes back as status 'unknown'.
  return NextResponse.json({ disk: await readDisk(), gate: getIngestDiskGate() })
}
