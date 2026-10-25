"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import {
  Inbox, CheckCircle, XCircle, Loader2, RefreshCw,
  AlertCircle, HardDrive, Timer, ShieldAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAuth, isAdmin } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"
import { IngestHealthPanel } from "@/components/ingest-health-panel"
import { JobViewLink } from "@/components/job-view-link"
import { jobAccountingTitle, jobLabel, phaseLine } from "@/lib/import-summary"

// ─── Types ───────────────────────────────────────────────────────────────────

interface InboxFileEntry {
  name:       string
  size_bytes: number
  mtime:      string
}

interface DoneEntry {
  id:            number
  filename:      string
  status:        'done' | 'failed' | 'held'
  imported:      number
  known?:        number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  created_at:    string
  /** Rows that repeat inside the file, and why a file added nothing; null on a job from before they were recorded. */
  repeats?:      number | null
  note?:         string | null
  /** The ingest quality gate's verdict for this job and its first reason, when it recorded one. */
  gate_level?:   string | null
  gate_note?:    string | null
}

interface CurrentProgress {
  filename:        string
  started_at:      number
  elapsed_ms:      number
  rows_imported:   number
  file_size_bytes: number
  /** Bytes of the file read so far, when the importer can count them (plain and archived files). */
  bytes_read?:     number | null
  rows_per_sec:    number
  est_total_rows:  number | null
  pct:             number | null
  eta_ms:          number | null
  /** Novelty-aware ingest only. */
  phase?:          'parsing' | 'checking' | 'inserting' | null
  rows_staged?:    number
  rows_known?:     number
  slab?:           number | null
  slabs?:          number | null
}

interface GateReportView {
  level:      'pass' | 'warn' | 'hold'
  phase:      'early' | 'final' | 'sample'
  reasons:    string[]
  lines:      number
  stored:     number
  /** Unsplit lines that cannot hold a credential at all (a banner, a divider, a bare link): not part of `unsplitPct`. A report written before they were counted has none. */
  noCredential?: number
  junkPct:    number
  unsplitPct: number
  garbagePct: number
  kinds:      Record<string, number>
  shapes:     Array<{ shape: string; count: number }>
}

interface HeldEntry extends InboxFileEntry {
  report: GateReportView | null
}

interface InboxStatus {
  watcher_active:   boolean
  current_file:     string | null
  queue_depth:      number
  current_progress: CurrentProgress | null
  /** One entry per file being imported (several at once when UPLOAD_CONCURRENCY is above 1). */
  jobs_progress?:   CurrentProgress[]
  waiting:          InboxFileEntry[]   // excludes file currently being processed
  waiting_total:    number             // true waiting + 1 if processing
  failed:           InboxFileEntry[]
  held?:            HeldEntry[]
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

/** The progress card of one file being imported. */
function ProgressCard({ p }: { p: CurrentProgress }) {
  return (
    <Card className="border-green-500/30 bg-green-500/5">
      <CardHeader className="py-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-green-500" />
          Processing
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 pb-4 space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-mono truncate max-w-xs text-muted-foreground" title={p.filename}>
            {p.filename}
          </span>
          <span className="tabular-nums shrink-0 text-muted-foreground ml-2">
            {p.bytes_read != null ? `${fmtBytes(p.bytes_read)} of ${fmtBytes(p.file_size_bytes)} read` : fmtBytes(p.file_size_bytes)}
          </span>
        </div>
        {/* Progress bar */}
        {p.pct !== null && (
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>
                {p.phase
                  ? `${fmtRows(p.rows_staged ?? 0)} rows read`
                  : `${fmtRows(p.rows_imported)} rows imported`}
              </span>
              <span className="font-medium text-foreground">{p.pct}%</span>
              {p.est_total_rows && (
                <span>est. {fmtRows(p.est_total_rows)} total</span>
              )}
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500 transition-all"
                style={{ width: `${Math.min(100, p.pct)}%` }}
              />
            </div>
          </div>
        )}
        {p.pct === null && (
          <p className="text-xs text-muted-foreground">
            {p.phase
              ? `${fmtRows(p.rows_staged ?? 0)} rows read`
              : `${fmtRows(p.rows_imported)} rows imported`}
            {(p.phase ? (p.rows_staged ?? 0) : p.rows_imported) === 0 && ' — parsing first batch…'}
          </p>
        )}
        {p.phase && (
          <p className="text-xs text-muted-foreground">
            {phaseLine({
              phase:    p.phase,
              staged:   p.rows_staged,
              imported: p.rows_imported,
              known:    p.rows_known,
              slab:     p.slab,
              slabs:    p.slabs,
            })}
          </p>
        )}
        <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
          <span><span className="font-medium text-foreground">{fmtRows(p.rows_per_sec)}</span> rows/s</span>
          <span>Elapsed: <span className="font-medium text-foreground">{fmtDuration(p.elapsed_ms)}</span></span>
          {p.eta_ms !== null && p.eta_ms > 0 && (
            <span>ETA: <span className="font-medium text-foreground">{fmtEta(p.eta_ms)}</span></span>
          )}
        </div>
      </CardContent>
    </Card>
  )
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
  const [releasing, setReleasing]     = useState<string | null>(null)

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

  const release = useCallback(async (filename: string) => {
    setReleasing(filename)
    try {
      const res = await fetch('/api/inbox/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      const body = res.ok ? await res.json().catch(() => null) as { moved?: string[] } | null : null
      if (res.ok && body?.moved?.includes(filename)) toast({ title: `${filename} released: it is imported once, and the quality gate will not hold it again` })
      else if (res.ok) toast({ title: 'Nothing was released', description: `${filename} is gone from the Held list, or its name cannot be released from here (a name with ".." in it must be moved out of inbox/held by hand).`, variant: 'destructive' })
      else            toast({ title: 'Release failed', variant: 'destructive' })
    } catch {
      toast({ title: 'Release failed', variant: 'destructive' })
    } finally {
      setReleasing(null)
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

      {/* Currently Processing — one progress card per file in flight */}
      {(data?.jobs_progress ?? (data?.current_progress ? [data.current_progress] : [])).map(p => (
        <ProgressCard key={p.filename} p={p} />
      ))}

      {/* Ingest health — same ClickHouse-pressure signal shown on /upload; the
          underlying metrics already cover both HTTP uploads and this watcher. */}
      <IngestHealthPanel />

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

      {/* Held by the ingest quality gate */}
      {data && (data.held?.length ?? 0) > 0 && (
        <Card data-testid="held-card">
          <CardHeader className="py-3">
            <CardTitle className="text-base text-amber-600 dark:text-amber-400">
              Held by the quality gate ({data.held!.length} files)
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              These files were stopped before one row was stored. Either too many of their lines could not be read as a login and a password, or too many of the rows
              that were read break the rules of a clean row (a login that is a link, a password that holds a link). The reasons below say which. Release imports a file
              once anyway, with its rows exactly as they were read; a layout the parser does not know yet is better fixed in the parser first.
            </p>
          </CardHeader>
          <CardContent className="pt-0 pb-4">
            <div className="space-y-3">
              {data.held!.map(f => (
                <div key={f.name} className="text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                    <span className="font-mono truncate flex-1 text-muted-foreground" title={f.name}>{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{fmtBytes(f.size_bytes)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => release(f.name)}
                      disabled={releasing === f.name}
                      className="h-6 px-2 text-xs"
                    >
                      {releasing === f.name ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      <span className="ml-1">Release</span>
                    </Button>
                  </div>
                  {f.report ? (
                    <div className="pl-5 space-y-0.5 text-muted-foreground">
                      {f.report.reasons.map(r => <p key={r}>{r}</p>)}
                      <p className="tabular-nums">
                        {fmtRows(f.report.lines)} lines read, {fmtRows(f.report.stored)} stored; {f.report.junkPct}% of the stored rows break a rule,
                        {' '}{f.report.unsplitPct}% of the lines could not be split, {f.report.garbagePct}% are garbage
                        {f.report.phase === 'early' ? ' (stopped early, after the first million lines)' : ''}
                        {f.report.phase === 'sample' ? ' (stopped before the import started; the numbers come from slices read across the file, not from all of it)' : ''}
                      </p>
                      {(f.report.noCredential ?? 0) > 0 && (
                        <p className="tabular-nums">
                          {fmtRows(f.report.noCredential ?? 0)} more lines could not be split but carry no login and password at all (banners, dividers, bare links); they are not counted.
                        </p>
                      )}
                      {Object.keys(f.report.kinds).length > 0 && (
                        <p>{Object.entries(f.report.kinds).map(([k, n]) => `${k}: ${fmtRows(n)}`).join(', ')}</p>
                      )}
                      {f.report.shapes.length > 0 && (
                        <details>
                          <summary className="cursor-pointer">Most common shapes of the rows that break a rule</summary>
                          <ul className="font-mono">
                            {f.report.shapes.slice(0, 10).map(s => <li key={s.shape}>{fmtRows(s.count)} × {s.shape}</li>)}
                          </ul>
                        </details>
                      )}
                    </div>
                  ) : (
                    <p className="pl-5 text-muted-foreground">No report was recorded for this file.</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
                    : job.status === 'held'
                      ? <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                      : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                  }
                  <span className="font-mono truncate flex-1 text-muted-foreground" title={job.filename}>
                    {job.filename}
                  </span>
                  {job.status === 'done' ? (
                    <>
                      <span className="tabular-nums shrink-0" title={jobAccountingTitle(job)}>{jobLabel(job, fmtRows)}</span>
                      {job.gate_level === 'warn' && (
                        <span className="text-amber-600 shrink-0" title={job.gate_note ?? 'The quality gate warned about this file'}>gate: warn</span>
                      )}
                      <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                      </span>
                      <JobViewLink job={job} />
                    </>
                  ) : (
                    <span className={`${job.status === 'held' ? 'text-amber-600' : 'text-red-500'} truncate max-w-xs`} title={job.error_message ?? ''}>
                      {job.error_message ?? job.status}
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
