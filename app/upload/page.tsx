"use client"
export const dynamic = "force-dynamic"

import { useState, useRef, useCallback, useEffect } from "react"
import { Upload, FileText, FileArchive, CheckCircle, AlertCircle, Loader2, X, TrendingDown, FlaskConical, CheckCheck, XCircle, ChevronDown, ChevronUp, Activity, Clock, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { useAuth, isAdmin } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"
import { buildTopRejections } from "@/lib/rejection-report"
import Link from "next/link"

interface ZipFileEntry {
  filename: string
  breach_name: string
  imported: number
}

interface UploadResult {
  imported: number
  skipped: number
  errors: number
  import_pct?: number
  /** For ZIP uploads: per-file breakdown. */
  files?: ZipFileEntry[]
  filename: string
  /** Breach tag resolved for single-file uploads. */
  breach_name?: string
  /** Per-reason rejection counts. */
  rejection_breakdown?: Record<string, number>
}

type UploadState = 'idle' | 'uploading' | 'success' | 'error'

export default function UploadPage() {
  const { user, loading: authLoading } = useAuth(true)
  const userIsAdmin = isAdmin(user)
  const { toast } = useToast()

  const [state, setState] = useState<UploadState>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const [liveImported, setLiveImported] = useState(0)
  const [liveSkipped, setLiveSkipped]   = useState(0)
  const [livePct, setLivePct]           = useState(0)
  const [elapsedMs, setElapsedMs]       = useState(0)
  const eventSourceRef                  = useRef<EventSource | null>(null)

  // ── Queue state ────────────────────────────────────────────────────────────
  const [fileQueue, setFileQueue]   = useState<File[]>([])
  const [queueIndex, setQueueIndex] = useState(0)
  const [allResults, setAllResults] = useState<UploadResult[]>([])
  const isProcessingRef             = useRef(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Clean up EventSource on unmount
  useEffect(() => {
    return () => { eventSourceRef.current?.close() }
  }, [])


  /**
   * Process a single file.
   *
   * Returns the UploadResult on success, null on any failure (SSE error,
   * network error, server error).  Always resolves — never rejects — so
   * the queue loop continues regardless.
   *
   * Returning null (instead of void) lets processQueue distinguish between
   * "file processed with results" and "file silently failed", avoiding the
   * blank-page trap where setState('success') fired with an empty allResults.
   */
  const processFileSingle = useCallback((file: File): Promise<UploadResult | null> => {
    return new Promise<UploadResult | null>((resolve) => {
      const ext = file.name.toLowerCase()
      if (!ext.endsWith('.txt') && !ext.endsWith('.csv') && !ext.endsWith('.zip')) {
        resolve(null)
        return
      }

      setState('uploading')
      setProgress(20)
      setResult(null)
      setErrorMsg('')

      const formData = new FormData()
      formData.append('file', file)

      fetch('/api/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then((data: any) => {
          setProgress(90)
          if (!data.success) throw new Error(data.error || 'Upload failed')

          if (data.jobId) {
            // SSE path — resolve when server signals done or error
            setLiveImported(0); setLiveSkipped(0); setLivePct(0); setElapsedMs(0)
            const es = new EventSource(`/api/upload/progress/${data.jobId}`)
            eventSourceRef.current = es

            // Guard against resolve being called twice (onerror can fire after
            // onmessage when the server cleanly closes the SSE stream).
            let settled = false
            const settle = (r: UploadResult | null) => {
              if (settled) return
              settled = true
              es.close()
              resolve(r)
            }

            es.onmessage = (e: MessageEvent) => {
              const d = JSON.parse(e.data)
              setLiveImported(d.imported ?? 0)
              setLiveSkipped(d.skipped   ?? 0)
              setLivePct(d.pct           ?? 0)
              setElapsedMs(d.elapsed_ms  ?? 0)

              if (d.status === 'done') {
                const r: UploadResult = {
                  imported:            d.imported,
                  skipped:             d.skipped,
                  errors:              0,
                  filename:            file.name,
                  breach_name:         '',
                  rejection_breakdown: d.rejection_breakdown ?? {},
                }
                setResult(r)
                setAllResults(prev => [...prev, r])
                settle(r)
              }
              if (d.status === 'error') {
                const msg = d.error || 'Upload failed'
                setErrorMsg(msg)
                toast({ title: `${file.name}: ${msg}`, variant: 'destructive' })
                settle(null)
              }
            }
            // onerror fires when connection drops OR server closes the stream.
            // After settle() the es is already closed so double-fire is safe.
            es.onerror = () => { settle(null) }
          } else {
            // Sync path (ZIP) — server already processed and returned results
            const r = data as UploadResult
            setResult(r)
            setAllResults(prev => [...prev, r])
            resolve(r)
          }
        })
        .catch(err => {
          const msg = err instanceof Error ? err.message : 'Upload failed'
          setErrorMsg(msg)
          toast({ title: `${file.name}: ${msg}`, variant: 'destructive' })
          setProgress(0)
          resolve(null)
        })
    })
  }, [toast])

  /** Enqueue multiple files and process them one at a time. */
  const processQueue = useCallback(async (files: File[]) => {
    if (isProcessingRef.current) return
    const valid = files.filter(f => f.name.match(/\.(txt|csv|zip)$/i))
    if (valid.length === 0) {
      toast({ title: 'No supported files selected (.txt, .csv, .zip)', variant: 'destructive' })
      return
    }

    isProcessingRef.current = true
    // Use a local array — React state (allResults) is async and stale in this
    // closure, so we can't rely on it to decide the terminal state.
    const localResults: Array<UploadResult> = []
    setFileQueue(valid)
    setAllResults([])
    setQueueIndex(0)

    for (let i = 0; i < valid.length; i++) {
      setQueueIndex(i)
      const r = await processFileSingle(valid[i])
      if (r !== null) localResults.push(r)
    }

    if (localResults.length > 0) {
      // At least one file succeeded — show the success summary.
      setState('success')
    } else {
      // Every file failed silently — go back to idle so the drop zone
      // reappears and the user isn't stuck on a blank page.
      setState('idle')
    }
    isProcessingRef.current = false
  }, [processFileSingle, toast])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) processQueue(files)
  }, [processQueue])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) processQueue(files)
    e.target.value = ''
  }, [processQueue])

  const reset = () => {
    setState('idle')
    setProgress(0)
    setResult(null)
    setErrorMsg('')
    setFileQueue([])
    setQueueIndex(0)
    setAllResults([])
    isProcessingRef.current = false
  }

  if (authLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
  }

  if (!userIsAdmin) {
    return (
      <div className="flex h-full items-center justify-center">
        <Alert className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Admin access required to upload files.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Upload Credentials</h1>
        <p className="text-muted-foreground mt-1">
          Upload <code className="text-xs bg-muted px-1 rounded">.txt</code>,{' '}
          <code className="text-xs bg-muted px-1 rounded">.csv</code>, or{' '}
          <code className="text-xs bg-muted px-1 rounded">.zip</code> files containing ULP data
          in <code className="text-xs bg-muted px-1 rounded">url:email:password</code> format.
        </p>
      </div>

      {/* Drop zone */}
      {state === 'idle' && (
        <Card
          className={`cursor-pointer border-2 border-dashed transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Upload className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-lg font-medium">Drop files here or click to browse</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Select multiple files — processed one at a time in order
            </p>
            <div className="mt-4 flex gap-3 flex-wrap justify-center">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-4 w-4" /> .txt / .csv — ULP text
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileArchive className="h-4 w-4" /> .zip — archive of .txt/.csv files
              </div>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".txt,.csv,.zip"
              className="hidden"
              onChange={handleFileInput}
            />
          </CardContent>
        </Card>
      )}

      {/* Uploading */}
      {state === 'uploading' && (
        <Card>
          <CardContent className="p-6 space-y-4">
            {/* Queue position badge */}
            {fileQueue.length > 1 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono truncate max-w-[200px]" title={fileQueue[queueIndex]?.name}>
                  {fileQueue[queueIndex]?.name}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {queueIndex + 1} / {fileQueue.length}
                </Badge>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Importing…
              </span>
              <span className="text-muted-foreground tabular-nums">
                {(elapsedMs / 1000).toFixed(0)}s elapsed
              </span>
            </div>
            {livePct > 0 ? (
              <>
                <Progress value={livePct} className="h-2" />
                <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
                  <span>{liveImported.toLocaleString()} imported</span>
                  <span>{livePct}%</span>
                  <span>{liveSkipped.toLocaleString()} skipped</span>
                </div>
              </>
            ) : (
              <Progress value={progress} className="h-2" />
            )}
          </CardContent>
        </Card>
      )}

      {/* Success */}
      {state === 'success' && allResults.length > 0 && (() => {
        const totalImported = allResults.reduce((s, r) => s + r.imported, 0)
        const totalSkipped  = allResults.reduce((s, r) => s + r.skipped,  0)
        const totalErrors   = allResults.reduce((s, r) => s + r.errors,   0)
        const mergedBreakdown = allResults.reduce((acc, r) => {
          for (const [k, v] of Object.entries(r.rejection_breakdown ?? {}))
            acc[k] = (acc[k] ?? 0) + v
          return acc
        }, {} as Record<string, number>)
        const total      = totalImported + totalSkipped
        const import_pct = total > 0 ? Math.round(totalImported / total * 1000) / 10 : 0
        const fileRows = allResults.length > 1
          ? allResults.flatMap(r =>
              r.files ?? [{ filename: r.filename, breach_name: r.breach_name ?? '', imported: r.imported }]
            )
          : allResults[0].files
        const displayResult: UploadResult = {
          imported:            totalImported,
          skipped:             totalSkipped,
          errors:              totalErrors,
          import_pct,
          filename:            allResults.length === 1
                                 ? allResults[0].filename
                                 : `${allResults.length} files`,
          breach_name:         allResults.length === 1 ? allResults[0].breach_name : undefined,
          rejection_breakdown: mergedBreakdown,
          files:               fileRows,
        }

        return (
          <Card className="border-green-500/30 bg-green-500/5">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                <CardTitle className="text-green-600 dark:text-green-400">Import complete</CardTitle>
              </div>
              <CardDescription className="flex items-center gap-2 flex-wrap">
                <span>{displayResult.filename}</span>
                {displayResult.breach_name && (
                  <Badge variant="outline" className="text-xs">{displayResult.breach_name}</Badge>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <StatBox label="Imported" value={displayResult.imported.toLocaleString()} color="green" />
                <StatBox label="Skipped"  value={displayResult.skipped.toLocaleString()}  color="yellow" />
                <StatBox label="Errors"   value={displayResult.errors.toLocaleString()}   color="red" />
              </div>

              {displayResult.import_pct !== undefined && (
                <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-muted-foreground">Import rate</span>
                      <span className={`text-sm font-semibold tabular-nums ${
                        import_pct >= 80 ? 'text-green-600 dark:text-green-400'
                        : import_pct >= 50 ? 'text-yellow-600 dark:text-yellow-400'
                        : 'text-red-600 dark:text-red-400'
                      }`}>
                        {import_pct}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          import_pct >= 80 ? 'bg-green-500'
                          : import_pct >= 50 ? 'bg-yellow-500'
                          : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(100, import_pct)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {displayResult.rejection_breakdown && displayResult.skipped > 0 && (() => {
                const rejTotal   = displayResult.imported + displayResult.skipped
                const rejections = buildTopRejections(displayResult.rejection_breakdown, rejTotal)
                if (rejections.length === 0) return null
                return (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground font-medium">Why lines were skipped</p>
                    </div>
                    <div className="space-y-1.5">
                      {rejections.map(r => (
                        <div key={r.reason} className="flex items-center gap-2 text-xs">
                          <div className="w-24 shrink-0">
                            <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-orange-400/70" style={{ width: `${Math.min(100, r.pct)}%` }} />
                            </div>
                          </div>
                          <span className="tabular-nums text-muted-foreground shrink-0 w-10 text-right">{r.pct}%</span>
                          <span className="text-muted-foreground truncate">{r.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}

              {displayResult.files && displayResult.files.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">
                    Files imported ({displayResult.files.length}):
                  </p>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {displayResult.files.map(f => (
                      <div key={f.filename} className="flex items-center gap-2 text-xs py-0.5">
                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="font-mono truncate flex-1" title={f.filename}>{f.filename}</span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {f.imported.toLocaleString()} rows
                        </span>
                        {f.breach_name && (
                          <Badge variant="outline" className="text-xs shrink-0">{f.breach_name}</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button onClick={reset} variant="outline">Upload more</Button>
                <Button asChild>
                  <Link href="/credentials">Search credentials</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })()}

      {/* Error */}
      {state === 'error' && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>{errorMsg}</span>
            <Button size="sm" variant="ghost" onClick={reset}><X className="h-4 w-4" /></Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Queue status — always visible for admins */}
      <QueueStatusPanel />

      {/* Format guide */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Format Reference</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="rounded bg-muted p-3 font-mono text-xs space-y-1">
            <div className="text-muted-foreground"># Colon separator</div>
            <div>example.com/login:user@email.com:password123</div>
            <div>https://site.com/auth:username:pass!word#456</div>
            <div className="text-muted-foreground mt-1"># Semicolon separator</div>
            <div>site.com;admin@test.com;abc123</div>
            <div className="text-muted-foreground mt-1"># Tab separator</div>
            <div>site.com{'  '}user@domain.com{'  '}secret</div>
          </div>
          <p className="text-xs text-muted-foreground">
            Empty lines and lines starting with <code>#</code> or <code>{'// '}</code> are skipped.
            Domain is extracted automatically from the URL.
          </p>
        </CardContent>
      </Card>

      {/* Parser Dry-Run */}
      <ParseSamplePanel />
    </div>
  )
}


// ─── Parser Dry-Run Panel ─────────────────────────────────────────────────────

interface ParseSummary {
  total_lines: number
  parsed: number
  skipped: number
  import_pct: number
}

interface ParseLineResult {
  line: number
  raw: string
  ok: boolean
  cred?: { url: string; email: string; password: string; domain: string }
  reason?: string
  label?: string
}

interface ParseSampleResponse {
  success: boolean
  summary: ParseSummary
  top_rejections: { reason: string; count: number; pct: number; label: string }[]
  recommendations: string[]
  lines?: ParseLineResult[]
  note?: string
}

function ParseSamplePanel() {
  const { toast } = useToast()
  const [text, setText]                   = useState('')
  const [result, setResult]               = useState<ParseSampleResponse | null>(null)
  const [loading, setLoading]             = useState(false)
  const [showLines, setShowLines]         = useState(false)
  const [open, setOpen]                   = useState(false)

  const run = async () => {
    if (!text.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res  = await fetch('/api/admin/parse-sample', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Parse failed')
      setResult(json)
      setShowLines(false)
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : 'Parse failed', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-violet-500" />
            <CardTitle className="text-base">Test Parser (Dry Run)</CardTitle>
          </div>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
        <CardDescription className="text-xs mt-1">
          Paste up to 10,000 lines of raw credential text to preview how many would import and why lines are rejected — without storing anything.
        </CardDescription>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={"https://example.com:user@email.com:password123\nsite.net:admin:secret456\n..."}
            className="w-full h-40 rounded-md border bg-muted/30 p-3 font-mono text-xs resize-y focus:outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/40"
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={run} disabled={loading || !text.trim()} className="gap-1.5">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
              {loading ? 'Parsing…' : 'Run Parser'}
            </Button>
            {result && (
              <Button size="sm" variant="ghost" onClick={() => { setResult(null); setText('') }}>
                <X className="mr-1 h-3.5 w-3.5" />Clear
              </Button>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {text.split('\n').filter(l => l.trim()).length.toLocaleString()} lines
            </span>
          </div>

          {result && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-md border bg-background p-3 text-center">
                  <p className="text-xl font-bold text-foreground">{result.summary.total_lines.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">Total lines</p>
                </div>
                <div className="rounded-md border bg-background p-3 text-center">
                  <p className="text-xl font-bold text-green-600 dark:text-green-400">{result.summary.parsed.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">Would import</p>
                </div>
                <div className="rounded-md border bg-background p-3 text-center">
                  <p className="text-xl font-bold text-orange-500">{result.summary.skipped.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">Skipped</p>
                </div>
              </div>

              {/* Import rate bar */}
              <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">Estimated import rate</span>
                    <span className={`text-sm font-semibold tabular-nums ${
                      result.summary.import_pct >= 80 ? 'text-green-600 dark:text-green-400'
                      : result.summary.import_pct >= 50 ? 'text-yellow-600 dark:text-yellow-400'
                      : 'text-red-500'
                    }`}>{result.summary.import_pct}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        result.summary.import_pct >= 80 ? 'bg-green-500'
                        : result.summary.import_pct >= 50 ? 'bg-yellow-500'
                        : 'bg-red-500'
                      }`}
                      style={{ width: `${Math.min(100, result.summary.import_pct)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Recommendations */}
              {result.recommendations.length > 0 && (
                <div className="space-y-1.5">
                  {result.recommendations.map((rec, i) => (
                    <div key={i} className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
                      rec.includes('healthy') ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                    }`}>
                      {rec.includes('healthy')
                        ? <CheckCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        : <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      }
                      <span>{rec}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Top rejections */}
              {result.top_rejections.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground font-medium">Top rejection reasons</p>
                  </div>
                  <div className="space-y-1.5">
                    {result.top_rejections.map(r => (
                      <div key={r.reason} className="flex items-center gap-2 text-xs">
                        <div className="w-24 shrink-0">
                          <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                            <div className="h-full rounded-full bg-orange-400/70" style={{ width: `${Math.min(100, r.pct)}%` }} />
                          </div>
                        </div>
                        <span className="tabular-nums text-muted-foreground shrink-0 w-10 text-right">{r.pct}%</span>
                        <span className="text-muted-foreground">{r.label}</span>
                        <span className="text-muted-foreground/50 tabular-nums ml-auto">×{r.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Per-line results toggle */}
              {result.lines && result.lines.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowLines(!showLines)}
                    className="text-xs text-primary/70 hover:text-primary transition-colors flex items-center gap-1"
                  >
                    {showLines ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {showLines ? 'Hide' : 'Show'} per-line results ({result.lines.length} lines)
                  </button>

                  {showLines && (
                    <div className="mt-2 rounded-md border bg-muted/20 divide-y max-h-80 overflow-y-auto">
                      {result.lines.map(l => (
                        <div key={l.line} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
                          <span className="text-muted-foreground/50 tabular-nums w-8 shrink-0 text-right">
                            {l.line}
                          </span>
                          {l.ok
                            ? <CheckCheck className="h-3 w-3 text-emerald-500 shrink-0 mt-0.5" />
                            : <XCircle className="h-3 w-3 text-red-400 shrink-0 mt-0.5" />
                          }
                          <span className="font-mono truncate flex-1 text-foreground/80" title={l.raw}>{l.raw}</span>
                          {!l.ok && l.label && (
                            <Badge variant="outline" className="text-[10px] shrink-0 border-orange-400/30 text-orange-500 py-0">
                              {l.label}
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {result.note && (
                <p className="text-[11px] text-muted-foreground/60 italic">{result.note}</p>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

// ─── Queue Status Panel ───────────────────────────────────────────────────────

interface QueueJob {
  id:            number
  source:        'http' | 'inbox'
  filename:      string
  status:        'done' | 'failed'
  imported:      number
  skipped:       number
  duration_ms:   number
  error_message: string | null
  breach_name:   string | null
  created_at:    string
}

interface QueueStatus {
  queue: {
    active:       number
    pending:      number
    current_file: string | null
  }
  recent: QueueJob[]
  totals: {
    files_done:    number
    files_failed:  number
    rows_imported: number
    rows_skipped:  number
  }
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

function QueueStatusPanel() {
  const [open, setOpen]   = useState(true)
  const [data, setData]   = useState<QueueStatus | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch('/api/upload/queue-status')
        if (!res.ok) { setError(true); return }
        const json = await res.json()
        if (!cancelled) { setData(json); setError(false) }
      } catch {
        if (!cancelled) setError(true)
      }
    }

    poll()
    const id = setInterval(poll, 3_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const isActive = (data?.queue.active ?? 0) > 0 || (data?.queue.pending ?? 0) > 0

  const summary = data
    ? `${fmtRows(data.totals.rows_imported)} rows · ${data.totals.files_done} files · ${data.totals.files_failed} failed`
    : 'Loading…'

  return (
    <Card className="mt-6">
      <CardHeader
        className="cursor-pointer select-none py-3"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className={`h-4 w-4 ${isActive ? 'text-green-500 animate-pulse' : 'text-muted-foreground'}`} />
            <CardTitle className="text-base">Processing Queue</CardTitle>
            {isActive && (
              <Badge variant="outline" className="text-xs text-green-600 border-green-500/40">
                ● Live
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!open && <span className="text-xs text-muted-foreground">{summary}</span>}
            {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 pb-4 space-y-3">
          {error && (
            <p className="text-xs text-muted-foreground">Could not load queue status.</p>
          )}

          {data && (
            <>
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <div className="flex items-center gap-1.5">
                  {isActive
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-green-500" />
                    : <span className="h-3.5 w-3.5 flex items-center justify-center text-muted-foreground">○</span>
                  }
                  <span className={isActive ? 'text-green-600 dark:text-green-400 font-medium' : 'text-muted-foreground'}>
                    {isActive ? 'Processing' : 'Idle'}
                  </span>
                </div>
                {data.queue.current_file && (
                  <span className="text-xs font-mono text-muted-foreground truncate max-w-xs" title={data.queue.current_file}>
                    {data.queue.current_file}
                    {data.queue.pending > 0 && (
                      <span className="ml-2 text-muted-foreground">+{data.queue.pending} waiting</span>
                    )}
                  </span>
                )}
              </div>

              <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                <span><span className="font-medium text-foreground">{fmtRows(data.totals.rows_imported)}</span> rows imported</span>
                <span><span className="font-medium text-foreground">{data.totals.files_done}</span> files done</span>
                {data.totals.files_failed > 0 && (
                  <span className="text-red-500"><span className="font-medium">{data.totals.files_failed}</span> failed</span>
                )}
              </div>

              {data.recent.length > 0 && (
                <div className="space-y-0.5 max-h-52 overflow-y-auto">
                  {data.recent.map(job => (
                    <div key={job.id} className="flex items-center gap-2 text-xs py-0.5">
                      {job.status === 'done'
                        ? <CheckCircle className="h-3 w-3 shrink-0 text-green-500" />
                        : <XCircle    className="h-3 w-3 shrink-0 text-red-500" />
                      }
                      <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                        {job.source === 'http' ? 'http' : <Inbox className="h-2.5 w-2.5" />}
                      </Badge>
                      <span className="font-mono truncate flex-1 text-muted-foreground" title={job.filename}>
                        {job.filename}
                      </span>
                      {job.status === 'done' ? (
                        <>
                          <span className="tabular-nums shrink-0">{fmtRows(job.imported)} rows</span>
                          <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />{fmtDuration(job.duration_ms)}
                          </span>
                        </>
                      ) : (
                        <span className="text-red-500 truncate max-w-[200px]" title={job.error_message ?? ''}>
                          {job.error_message ?? 'failed'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {data.recent.length === 0 && (
                <p className="text-xs text-muted-foreground">No jobs processed yet.</p>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

function StatBox({ label, value, color }: { label: string; value: string; color: 'green' | 'yellow' | 'red' }) {
  const colors = {
    green: 'text-green-600 dark:text-green-400',
    yellow: 'text-yellow-600 dark:text-yellow-400',
    red: 'text-red-600 dark:text-red-400',
  }
  return (
    <div className="rounded-md border bg-background p-3 text-center">
      <p className={`text-2xl font-bold ${colors[color]}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
