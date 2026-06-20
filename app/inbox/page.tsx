"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import {
  Inbox, CheckCircle, XCircle, Loader2, RefreshCw,
  AlertCircle, HardDrive, Timer,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAuth, isAdmin } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"

// ─── Types ───────────────────────────────────────────────────────────────────

interface InboxFileEntry {
  name:       string
  size_bytes: number
  mtime:      string
}

interface DoneEntry {
  id:            number
  filename:      string
  status:        'done' | 'failed'
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
}

interface CurrentProgress {
  filename:        string
  started_at:      number
  elapsed_ms:      number
  rows_imported:   number
  file_size_bytes: number
  rows_per_sec:    number
  est_total_rows:  number | null
  pct:             number | null
  eta_ms:          number | null
}

interface InboxStatus {
  watcher_active:   boolean
  current_file:     string | null
  queue_depth:      number
  current_progress: CurrentProgress | null
  waiting:          InboxFileEntry[]   // excludes file currently being processed
  waiting_total:    number             // true waiting + 1 if processing
  failed:           InboxFileEntry[]
  done_count:       number
  done_recent:      DoneEntry[]
  in_flight_count?: number
  stale_in_flight?: number
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`
  if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(1)} MB`
  if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`
  return `${b} B`
}

function fmtRelTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1_000)
  if (diff < 5)    return 'just now'
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function fmtDuration(ms: number): string {
  if (ms < 1_000)    return `${ms}ms`
  if (ms < 60_000)   return `${(ms / 1_000).toFixed(0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1_000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function fmtEta(ms: number): string {
  if (ms < 60_000)   return `~${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) return `~${Math.round(ms / 60_000)}m`
  return `~${(ms / 3_600_000).toFixed(1)}h`
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { user, loading: authLoading } = useAuth(true)
  const userIsAdmin = isAdmin(user)
  const { toast } = useToast()

  const [data, setData]               = useState<InboxStatus | null>(null)
  const [loadError, setLoadError]     = useState(false)
  const [retrying, setRetrying]       = useState<string | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)
  const [scanning, setScanning]       = useState(false)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/api/inbox/status')
        if (!res.ok) { setLoadError(true); return }
        const json = await res.json()
        if (!cancelled) { setData(json); setLoadError(false) }
      } catch {
        if (!cancelled) setLoadError(true)
      }
    }
    poll()
    const id = setInterval(poll, 3_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const retry = useCallback(async (filename: string) => {
    setRetrying(filename)
    try {
      const res = await fetch('/api/inbox/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      if (res.ok) toast({ title: `${filename} queued for retry` })
      else        toast({ title: 'Retry failed', variant: 'destructive' })
    } catch {
      toast({ title: 'Retry failed', variant: 'destructive' })
    } finally {
      setRetrying(null)
    }
  }, [toast])

  const retryAll = useCallback(async () => {
    setRetryingAll(true)
    try {
      const res  = await fetch('/api/inbox/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const json = await res.json()
      toast({ title: `${json.moved?.length ?? 0} files queued for retry` })
    } catch {
      toast({ title: 'Retry all failed', variant: 'destructive' })
    } finally {
      setRetryingAll(false)
    }
  }, [toast])

  const forceScan = useCallback(async () => {
    setScanning(true)
    try {
      const res  = await fetch('/api/inbox/scan', { method: 'POST' })
      const json = await res.json()
      toast({ title: json.message ?? 'Scan triggered' })
    } catch {
      toast({ title: 'Force scan failed', variant: 'destructive' })
    } finally {
      setScanning(false)
    }
  }, [toast])

  if (authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }

  if (!userIsAdmin) {
    return (
      <div className="flex h-full items-center justify-center">
        <Alert className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Admin access required.</AlertDescription>
        </Alert>
      </div>
    )
  }

  const isActive = data?.watcher_active ?? false

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Inbox className="h-6 w-6" /> Inbox Monitor
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Drop <code className="text-xs bg-muted px-1 rounded">.txt</code>,{' '}
            <code className="text-xs bg-muted px-1 rounded">.csv</code>, or{' '}
            <code className="text-xs bg-muted px-1 rounded">.zip</code> files into{' '}
            <code className="text-xs bg-muted px-1 rounded">./inbox/</code> to process them automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-xs ${isActive ? 'text-green-600 border-green-500/40' : 'text-muted-foreground'}`}>
            {isActive ? '● Live' : '○ Idle'}
          </Badge>
          {/* Force Scan button — always visible so it's easy to find when stuck */}
          <Button
            size="sm"
            variant="outline"
            onClick={forceScan}
            disabled={scanning}
            className="h-7 text-xs"
            title="Clear stale queue entries and re-scan inbox/ for unprocessed files"
          >
            {scanning ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Force Scan
          </Button>
        </div>
      </div>

      {/* Stale inFlight warning — files may be stuck */}
      {data && (data.stale_in_flight ?? 0) > 0 && !isActive && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>
              {data.stale_in_flight} file(s) appear stuck — they are queued but not processing.
              This usually happens when files were moved out and back in while queued.
            </span>
            <Button size="sm" variant="outline" onClick={forceScan} disabled={scanning} className="ml-3 h-7 text-xs shrink-0">
              {scanning ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Fix Now
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Could not load inbox status.</AlertDescription>
        </Alert>
      )}

      {/* Status bar */}
      {data && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-6 text-sm flex-wrap">
              <div className="flex items-center gap-1.5">
                {isActive
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin text-green-500" />
                  : <span className="text-muted-foreground">○</span>
                }
                <span className={isActive ? 'text-green-600 dark:text-green-400 font-medium' : 'text-muted-foreground'}>
                  {isActive ? 'Processing' : 'Idle'}
                </span>
              </div>
              {data.current_file && (
                <span className="font-mono text-xs text-muted-foreground truncate max-w-xs" title={data.current_file}>
                  {data.current_file}
                  {data.queue_depth > 1 && (
                    <span className="ml-2">+{data.queue_depth - 1} waiting in queue</span>
                  )}
                </span>
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                Auto-refreshes every 3s
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Currently Processing — progress card */}
      {data?.current_progress && (
        <Card className="border-green-500/30 bg-green-500/5">
          <CardHeader className="py-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-green-500" />
              Processing
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 pb-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono truncate max-w-xs text-muted-foreground" title={data.current_progress.filename}>
                {data.current_progress.filename}
              </span>
              <span className="tabular-nums shrink-0 text-muted-foreground ml-2">
                {fmtBytes(data.current_progress.file_size_bytes)}
              </span>
            </div>
            {/* Progress bar */}
            {data.current_progress.pct !== null && (
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>{fmtRows(data.current_progress.rows_imported)} rows imported</span>
                  <span className="font-medium text-foreground">{data.current_progress.pct}%</span>
                  {data.current_progress.est_total_rows && (
                    <span>est. {fmtRows(data.current_progress.est_total_rows)} total</span>
                  )}
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{ width: `${Math.min(100, data.current_progress.pct)}%` }}
                  />
                </div>
              </div>
            )}
            {data.current_progress.pct === null && (
              <p className="text-xs text-muted-foreground">
                {fmtRows(data.current_progress.rows_imported)} rows imported
                {data.current_progress.rows_imported === 0 && ' — parsing first batch…'}
              </p>
            )}
            <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
              <span><span className="font-medium text-foreground">{fmtRows(data.current_progress.rows_per_sec)}</span> rows/s</span>
              <span>Elapsed: <span className="font-medium text-foreground">{fmtDuration(data.current_progress.elapsed_ms)}</span></span>
              {data.current_progress.eta_ms !== null && data.current_progress.eta_ms > 0 && (
                <span>ETA: <span className="font-medium text-foreground">{fmtEta(data.current_progress.eta_ms)}</span></span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Waiting */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Waiting ({data?.waiting.length ?? 0} files)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          {!data || data.waiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No files waiting — drop <code className="text-xs bg-muted px-1 rounded">.txt</code>/
              <code className="text-xs bg-muted px-1 rounded">.csv</code>/
              <code className="text-xs bg-muted px-1 rounded">.zip</code> files into{' '}
              <code className="text-xs bg-muted px-1 rounded">./inbox/</code> to start.
            </p>
          ) : (
            <div className="space-y-1">
              {data.waiting.map(f => (
                <div key={f.name} className="flex items-center gap-2 text-xs py-0.5">
                  <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={f.name}>{f.name}</span>
                  <span className={`tabular-nums shrink-0 ${f.size_bytes > 1_073_741_824 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                    {fmtBytes(f.size_bytes)}
                  </span>
                  <span className="text-muted-foreground shrink-0">{fmtRelTime(f.mtime)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Failed */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span className={data && data.failed.length > 0 ? 'text-red-600 dark:text-red-400' : ''}>
              Failed ({data?.failed.length ?? 0} files)
            </span>
            {data && data.failed.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={retryAll}
                disabled={retryingAll}
                className="h-7 text-xs"
              >
                {retryingAll
                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  : <RefreshCw className="h-3 w-3 mr-1" />
                }
                Retry All
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          {!data || data.failed.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failed files.</p>
          ) : (
            <div className="space-y-1.5">
              {data.failed.map(f => (
                <div key={f.name} className="flex items-center gap-2 text-xs py-0.5">
                  <XCircle className="h-3 w-3 shrink-0 text-red-500" />
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={f.name}>{f.name}</span>
                  <span className="text-muted-foreground shrink-0">{fmtBytes(f.size_bytes)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => retry(f.name)}
                    disabled={retrying === f.name}
                    className="h-6 px-2 text-xs"
                  >
                    {retrying === f.name
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />
                    }
                    <span className="ml-1">Retry</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Completed */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base">
            Completed ({data?.done_count ?? 0} total — last 10 shown)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 pb-4">
          {!data || data.done_recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files processed yet.</p>
          ) : (
            <div className="space-y-0.5">
              {data.done_recent.map(job => (
                <div key={job.id} className="flex items-center gap-2 text-xs py-0.5">
                  {job.status === 'done'
                    ? <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                    : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                  }
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={job.filename}>
                    {job.filename}
                  </span>
                  {job.status === 'done' ? (
                    <>
                      <span className="tabular-nums shrink-0">{fmtRows(job.imported)} rows</span>
                      <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                      </span>
                    </>
                  ) : (
                    <span className="text-red-500 truncate max-w-xs" title={job.error_message ?? ''}>
                      {job.error_message ?? 'failed'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
