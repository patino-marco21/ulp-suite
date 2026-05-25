"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import {
  ChevronLeft, ChevronRight, Loader2, FileText, Upload, Trash2, AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { useAuth, isAdmin } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

interface Source {
  filename: string
  line_count: number
  imported_at: string
  cred_count: number
}

interface ApiResult {
  success: boolean
  sources: Source[]
  total: number
  page: number
  pages: number
}

export default function SourcesPage() {
  const { user } = useAuth(true)
  const userIsAdmin = isAdmin(user)
  const { toast } = useToast()

  const [data, setData]         = useState<ApiResult | null>(null)
  const [loading, setLoading]   = useState(true)
  const [page, setPage]         = useState(1)
  const [toDelete, setToDelete] = useState<Source | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (p: number) => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/sources?page=${p}&limit=50`)
      const json = await res.json()
      if (json.success) {
        setData(json)
        setPage(p)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(1) }, [load])

  const handleDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      const params = new URLSearchParams({
        filename:    toDelete.filename,
        imported_at: toDelete.imported_at,
      })
      const res  = await fetch(`/api/sources?${params}`, { method: 'DELETE' })
      const json = await res.json()

      if (!res.ok || !json.success) throw new Error(json.error || 'Delete failed')

      const msg = json.deleted_credentials
        ? `Deleted source and queued removal of all credentials from "${toDelete.filename}".`
        : `Deleted source entry. Other imports of "${toDelete.filename}" still exist — credentials retained.`

      toast({ title: 'Source deleted', description: msg })
      setToDelete(null)
      load(page)
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Sources</h1>
            <p className="text-sm text-muted-foreground">
              {data?.total.toLocaleString() ?? 0} file{data?.total !== 1 ? 's' : ''} imported
            </p>
          </div>
          <Button asChild size="sm">
            <Link href="/upload">
              <Upload className="mr-2 h-4 w-4" />Upload
            </Link>
          </Button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        {!data || data.sources.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
            <FileText className="h-12 w-12 opacity-30" />
            <p>No sources yet. Upload a ULP file to get started.</p>
            <Button asChild variant="outline">
              <Link href="/upload">Upload credentials</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {data.sources.map((source, i) => (
              <Card key={i}>
                <CardContent className="flex items-center justify-between py-3 px-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium truncate" title={source.filename}>
                        {source.filename}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(source.imported_at).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="secondary">
                        {Number(source.line_count).toLocaleString()} lines
                      </Badge>
                      {source.cred_count > 0 && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {Number(source.cred_count).toLocaleString()} creds
                        </span>
                      )}
                    </div>

                    {userIsAdmin && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete this source"
                        onClick={() => setToDelete(source)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {data && data.pages > 1 && (
        <div className="flex items-center justify-center gap-2 border-t px-4 py-3">
          <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">Page {data.page} of {data.pages}</span>
          <Button size="sm" variant="outline" disabled={page >= data.pages || loading} onClick={() => load(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!toDelete} onOpenChange={open => { if (!open && !deleting) setToDelete(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete source?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  You are about to delete the import entry for:
                </p>
                <div className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                  {toDelete?.filename}
                </div>
                <p className="text-xs text-muted-foreground">
                  Imported: {toDelete ? new Date(toDelete.imported_at).toLocaleString() : ''}
                  {toDelete?.line_count ? ` · ${Number(toDelete.line_count).toLocaleString()} lines` : ''}
                  {toDelete?.cred_count ? ` · ${Number(toDelete.cred_count).toLocaleString()} credentials` : ''}
                </p>
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400 text-xs leading-relaxed">
                  <strong>If this is the last import of this file</strong>, all credentials from{' '}
                  <span className="font-mono">&ldquo;{toDelete?.filename}&rdquo;</span> will be permanently deleted.{' '}
                  If other imports of this file still exist, credentials are kept.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Deleting…</>
              ) : (
                <><Trash2 className="mr-2 h-4 w-4" />Delete source</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
