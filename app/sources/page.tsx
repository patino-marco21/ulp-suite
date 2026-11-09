"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import {
  ChevronLeft, ChevronRight, Loader2, FileText, Upload, Trash2, AlertTriangle, Search, X,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { formatBytes } from "@/lib/utils"
import { normalizeQuery, utcDate, type SourceStatus } from "@/lib/sources-search"
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
  /** Only in a search answer. */
  status?: SourceStatus
  size?: number
}

interface ApiResult {
  success: boolean
  sources: Source[]
  total: number
  page: number
  pages: number
  query?: string
}

const STATUS_BADGE: Record<SourceStatus, { label: string; variant: "outline" | "destructive"; className: string; hint: string }> = {
  ingested:  { label: "Ingested", variant: "outline", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", hint: "This file is in the source list" },
  processed: { label: "Processed earlier", variant: "outline", className: "", hint: "Imported before the file ledger existed: the name is known, the size is not" },
  held:      { label: "Held", variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", hint: "The quality gate stopped this file; it was not ingested" },
  failed:    { label: "Failed", variant: "destructive", className: "", hint: "The import failed and no later run finished it" },
}

export default function SourcesPage() {
  const { user } = useAuth(true)
  const userIsAdmin = isAdmin(user)
  const { toast } = useToast()

  const [data, setData]         = useState<ApiResult | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [page, setPage]         = useState(1)
  const [query, setQuery]       = useState("")
  const [toDelete, setToDelete] = useState<Source | null>(null)
  const [deleting, setDeleting] = useState(false)

  // The query the list is showing: under 2 characters is the plain list.
  const activeQuery = normalizeQuery(query) ?? ""

  const load = useCallback(async (p: number, q: string, signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: String(p), limit: "50" })
      if (q) params.set("q", q)
      const res  = await fetch(`/api/sources?${params}`, { signal })
      const json = await res.json()
      if (json.success) {
        setData(json)
        setPage(p)
      } else {
        setError(q ? "The search failed. Try again." : "The list could not be loaded.")
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(q ? "The search failed. Try again." : "The list could not be loaded.")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  // Typing waits 300 ms; clearing the box shows the list at once. A newer request cancels the older one, so a slow answer never overwrites a newer one.
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => { load(1, activeQuery, controller.signal) }, activeQuery ? 300 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [activeQuery, load])

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
      load(page, activeQuery)
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
      <div className="border-b px-6 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Sources</h1>
            <p className="text-sm text-muted-foreground">
              {data?.query
                ? `${data.total.toLocaleString()} match${data.total !== 1 ? 'es' : ''} for “${data.query}”`
                : `${data?.total.toLocaleString() ?? 0} file${data?.total !== 1 ? 's' : ''} imported`}
            </p>
          </div>
          <Button asChild size="sm">
            <Link href="/upload">
              <Upload className="mr-2 h-4 w-4" />Upload
            </Link>
          </Button>
        </div>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Check a file name before you download it"
            aria-label="Search sources by file name"
            className="pl-9 pr-9"
            maxLength={200}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {loading && data && <Loader2 className="absolute right-9 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
        </div>
        {query.trim().length === 1 && (
          <p className="text-xs text-muted-foreground">Type at least 2 characters to search.</p>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <p role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}
        {!data || data.sources.length === 0 ? (
          data?.query ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Search className="h-10 w-10 opacity-30" />
              <p className="text-foreground">No file with “{data.query}” in its name has been ingested or processed.</p>
              <p className="max-w-md text-sm">A different name does not make a file new: the importer also compares what is inside and adds only credentials it has not seen.</p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
              <FileText className="h-12 w-12 opacity-30" />
              <p>No sources yet. Upload a ULP file to get started.</p>
              <Button asChild variant="outline">
                <Link href="/upload">Upload credentials</Link>
              </Button>
            </div>
          )
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
                        {utcDate(source.imported_at).toLocaleString()}
                        {source.status === 'ingested' || source.status === 'processed'
                          ? source.size
                            ? <> · <span title={`${source.size.toLocaleString()} bytes`}>{formatBytes(source.size)}</span> ({source.size.toLocaleString()} bytes)</>
                            : ' · size not recorded'
                          : null}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    <div className="flex flex-col items-end gap-1">
                      {source.status && (
                        <Badge variant={STATUS_BADGE[source.status].variant} className={STATUS_BADGE[source.status].className} title={STATUS_BADGE[source.status].hint}>
                          {STATUS_BADGE[source.status].label}
                        </Badge>
                      )}
                      <Badge variant="secondary">
                        {Number(source.line_count).toLocaleString()} lines
                      </Badge>
                      {source.cred_count > 0 && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {Number(source.cred_count).toLocaleString()} creds
                        </span>
                      )}
                    </div>

                    {userIsAdmin && (!source.status || source.status === 'ingested') && (
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
          <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => load(page - 1, activeQuery)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">Page {data.page} of {data.pages}</span>
          <Button size="sm" variant="outline" disabled={page >= data.pages || loading} onClick={() => load(page + 1, activeQuery)}>
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
                  Imported: {toDelete ? utcDate(toDelete.imported_at).toLocaleString() : ''}
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
