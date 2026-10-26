"use client"
export const dynamic = "force-dynamic"

import { useRef, useState } from "react"
import {
  BarChart3, Loader2, X, Download, Upload, ChevronDown, ChevronUp, AlertTriangle, Square,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { localToUtcIso } from "@/lib/imported-window"
import { ImportedWindowFilter, EMPTY_IMPORTED_WINDOW, type ImportedWindowValue } from "@/components/imported-window-filter"
import { parseBatchText } from "@/lib/batch-input"
import {
  SITE_COUNTS_MAX_PER_LIST, SITE_COUNTS_REQUEST_SIZE, siteCountsCsv, splitRequests, type SiteCount,
} from "@/lib/site-counts-input"

// ── Types ─────────────────────────────────────────────────────────────────────

interface CountRow {
  site: string
  result: SiteCount
}

interface CountsResponse {
  success: boolean
  subdomains_counted?: boolean
  results?: Record<string, SiteCount>
  error?: string
}

/** The biggest list file the page reads: a list of sites is a few KB, this only stops a wrong file from freezing the tab. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString())

/** Needs attention first (not counted), then the most rows, then the sites with none. */
function displayOrder(rows: CountRow[]): CountRow[] {
  const rank = (r: SiteCount) => (r.error ? 0 : r.count && r.count > 0 ? 1 : 2)
  return [...rows].sort((a, b) => rank(a.result) - rank(b.result) || (b.result.count ?? 0) - (a.result.count ?? 0))
}

// ── One site ──────────────────────────────────────────────────────────────────

function SiteRow({ row }: { row: CountRow }) {
  const [open, setOpen] = useState(false)
  const { site, result } = row
  const expandable = result.top_subdomains.length > 0
  const muted = !result.error && result.count === 0

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => expandable && setOpen(o => !o)}
        className={`w-full grid grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_6rem_1rem] items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          expandable ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        }`}
        aria-expanded={expandable ? open : undefined}
      >
        <span className="min-w-0">
          <span className={`block font-mono text-xs truncate ${muted ? "text-muted-foreground" : ""}`} title={site}>{site}</span>
          {result.searched_as && (
            <span className="block text-[10px] text-muted-foreground truncate" title={`Counted as ${result.searched_as}`}>
              counted as {result.searched_as}
            </span>
          )}
          {result.error && (
            <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />{result.error}
            </span>
          )}
        </span>
        <span className={`text-right text-sm font-semibold tabular-nums ${muted ? "text-muted-foreground font-normal" : ""}`}>{fmt(result.count)}</span>
        <span className="text-right text-xs tabular-nums text-muted-foreground">{fmt(result.host_count)}</span>
        <span className="text-right text-xs tabular-nums text-muted-foreground">{fmt(result.subdomain_count)}</span>
        <span className="text-right text-xs tabular-nums text-muted-foreground">{fmt(result.subdomains)}</span>
        {expandable
          ? (open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />)
          : <span />}
      </button>

      {open && expandable && (
        <div className="border-t bg-muted/20 px-4 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Subdomains with the most rows{result.subdomains !== null && result.subdomains > result.top_subdomains.length
              ? ` (${result.top_subdomains.length} of ${result.subdomains.toLocaleString()})` : ""}
          </p>
          <ul className="text-xs font-mono">
            {result.top_subdomains.map(s => (
              <li key={s.domain} className="flex justify-between gap-4 py-0.5">
                <span className="truncate" title={s.domain}>{s.domain}</span>
                <span className="tabular-nums text-muted-foreground">{s.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SiteCountsPage() {
  useAuth(true)
  const { toast } = useToast()

  const [rawInput, setRawInput] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [rows, setRows] = useState<CountRow[]>([])
  const [subdomainsCounted, setSubdomainsCounted] = useState(true)
  const [importedWindow, setImportedWindow] = useState<ImportedWindowValue>(EMPTY_IMPORTED_WINDOW)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const sites = parseBatchText(rawInput)
  const overLimit = sites.length > SITE_COUNTS_MAX_PER_LIST
  const importedAfterIso = localToUtcIso(importedWindow.after)
  const importedBeforeIso = localToUtcIso(importedWindow.before)

  async function readFile(file: File) {
    if (running) return
    if (file.size > MAX_FILE_BYTES) {
      toast({ title: "That file is too big for a list of sites", description: `Up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`, variant: "destructive" })
      return
    }
    setRawInput(await file.text())
    setFileName(file.name)
    setRows([])
  }

  async function runCount() {
    if (sites.length === 0 || overLimit || running) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setRows([])
    setSubdomainsCounted(true)
    setProgress({ done: 0, total: sites.length })
    const bound = {
      ...(importedAfterIso ? { imported_after: importedAfterIso } : {}),
      ...(importedBeforeIso ? { imported_before: importedBeforeIso } : {}),
    }
    try {
      let done = 0
      for (const run of splitRequests(sites, SITE_COUNTS_REQUEST_SIZE)) {
        const res = await fetch("/api/lookup/counts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: run, ...bound }),
          signal: controller.signal,
        })
        // An expired session is redirected to the sign-in page, which is not JSON.
        if (res.redirected || res.status === 401) throw new Error("Your session has expired. Sign in again, then count again.")
        const json: CountsResponse = await res.json()
        if (!json.success || !json.results) throw new Error(json.error || "Counting failed")
        const results = json.results
        setRows(prev => [...prev, ...run.map(site => ({ site, result: results[site] }))])
        if (json.subdomains_counted === false) setSubdomainsCounted(false)
        done += run.length
        setProgress({ done, total: sites.length })
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        toast({
          title: "Counting failed",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        })
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function downloadCSV() {
    const blob = new Blob([siteCountsCsv(displayOrder(rows))], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `site-counts-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Two spellings of one site are two lines but one site: the totals count each host once.
  const byHost = new Map<string, number>()
  for (const { result } of rows) if (result.host && result.count !== null) byHost.set(result.host, result.count)
  const totalRows = Array.from(byHost.values()).reduce((a, b) => a + b, 0)
  const withRows = rows.filter(r => r.result.found).length
  const notCounted = rows.filter(r => r.result.error).length
  const none = rows.length - withRows - notCounted

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-5">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          Site Counts
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Paste or upload a list of sites and see how many rows there are for each: the site itself and its subdomains, told apart
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left panel: the list ── */}
        <div
          className="w-80 shrink-0 border-r flex flex-col p-4 gap-3"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault()
            const file = e.dataTransfer.files?.[0]
            if (file) void readFile(file)
          }}
        >
          <div className="flex-1 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="site-list" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Sites, domains or URLs (one per line)
              </label>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => fileRef.current?.click()} disabled={running}>
                <Upload className="mr-1 h-3 w-3" />Upload a list
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,.tsv,.list,text/plain,text/csv"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) void readFile(file)
                  e.target.value = ""
                }}
              />
            </div>
            <Textarea
              id="site-list"
              value={rawInput}
              onChange={e => { setRawInput(e.target.value); setFileName(null) }}
              placeholder={"example.com\nhttps://www.corp.io/login\n*.bank.example\n..."}
              className="flex-1 resize-none font-mono text-xs min-h-[200px]"
              spellCheck={false}
              disabled={running}
            />
            <div className="flex items-center justify-between">
              <span className={`text-[10px] ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                {sites.length.toLocaleString()} site{sites.length === 1 ? "" : "s"}
                {fileName && ` · ${fileName}`}
                {overLimit && ` — at most ${SITE_COUNTS_MAX_PER_LIST.toLocaleString()}`}
              </span>
              {rawInput && !running && (
                <button
                  onClick={() => { setRawInput(""); setFileName(null); setRows([]) }}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                >
                  <X className="h-2.5 w-2.5" />Clear
                </button>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Only imported in a window (optional)</label>
            <div><ImportedWindowFilter value={importedWindow} onChange={setImportedWindow} /></div>
          </div>

          {running ? (
            <Button variant="outline" onClick={stop} className="w-full">
              <Square className="mr-2 h-3.5 w-3.5" />Stop
            </Button>
          ) : (
            <Button onClick={runCount} disabled={sites.length === 0 || overLimit} className="w-full">
              <BarChart3 className="mr-2 h-4 w-4" />Count {sites.length > 0 ? sites.length.toLocaleString() : ""} site{sites.length === 1 ? "" : "s"}
            </Button>
          )}
          <p className="text-[10px] text-muted-foreground">
            A site is its host and every subdomain. A path in an entry is ignored. A count is rows, so a login seen in two files counts twice.
          </p>
        </div>

        {/* ── Right panel: the counts ── */}
        <div className="flex-1 overflow-auto p-4">
          {rows.length === 0 && !running && (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              Paste or upload a list on the left and click Count
            </div>
          )}

          {(rows.length > 0 || running) && (
            <div className="flex flex-col gap-3">
              {running && (
                <div className="space-y-1" role="status" aria-live="polite">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Counted {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
                  </div>
                  <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
                </div>
              )}

              {!subdomainsCounted && (
                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Only each site&apos;s own host could be counted right now (the index that finds subdomains is being rebuilt), so these numbers leave subdomains out. Count again in a few minutes.
                  </p>
                </div>
              )}

              {rows.length > 0 && (
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary">{rows.length.toLocaleString()} counted</Badge>
                    <Badge variant={withRows > 0 ? "destructive" : "outline"}>{withRows.toLocaleString()} with rows</Badge>
                    <Badge variant="outline">{none.toLocaleString()} with none</Badge>
                    {notCounted > 0 && <Badge variant="outline" className="text-amber-600 border-amber-500/50">{notCounted.toLocaleString()} not counted</Badge>}
                    <span className="text-xs text-muted-foreground">{totalRows.toLocaleString()} rows in all</span>
                  </div>
                  <Button size="sm" variant="outline" onClick={downloadCSV}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />Export CSV
                  </Button>
                </div>
              )}

              {rows.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_6rem_6rem_1rem] gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span>Site</span>
                  <span className="text-right">Rows</span>
                  <span className="text-right">On the site</span>
                  <span className="text-right">On subdomains</span>
                  <span className="text-right">Subdomains</span>
                  <span />
                </div>
              )}

              <div className="flex flex-col gap-2">
                {displayOrder(rows).map(row => <SiteRow key={row.site} row={row} />)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
