"use client"
export const dynamic = "force-dynamic"

import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  BarChart3, Loader2, X, Download, Upload, ChevronDown, ChevronUp, ArrowUpDown, AlertTriangle, Square,
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
  SITE_COUNTS_MAX_PER_LIST, SITE_COUNTS_REQUEST_SIZE, nextSiteSort, orderSiteRows, planSites, siteCountsCsv, splitRequests,
  type SiteCount, type SiteSort, type SiteSortKey,
} from "@/lib/site-counts-input"
import { markFilterCounts, markRank, markStateOf, matchesMarkFilter, type MarkFilter, type MarkState, type SiteMarkPatch } from "@/lib/site-marks-input"
import { createSiteMarksStore } from "@/lib/site-marks-client"
import { COLS, SiteRow, type CountRow } from "@/components/site-count-row"
import { SiteMarkFilter } from "@/components/site-mark-filter"

// ── Types ─────────────────────────────────────────────────────────────────────

interface CountsResponse {
  success: boolean
  subdomains_counted?: boolean
  results?: Record<string, SiteCount>
  error?: string
}

/** The biggest list file the page reads: a list of sites is a few KB, this only stops a wrong file from freezing the tab. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

// ── One column header ─────────────────────────────────────────────────────────

/**
 * The header of a sortable column, as a button: its arrow says whether the table is sorted by the column and which way (the Credentials headers look the
 * same). Off while there is nothing to sort by (the Mark column before the marks are loaded).
 */
function SortHeader({ label, sortKey, sort, onSort, className, disabled = false }: {
  label: string
  sortKey: SiteSortKey
  sort: SiteSort | null
  onSort: (key: SiteSortKey) => void
  className: string
  disabled?: boolean
}) {
  const current = sort !== null && sort.key === sortKey ? sort : null
  const Arrow = current === null ? ArrowUpDown : current.direction === "desc" ? ChevronDown : ChevronUp
  const state = current === null ? "" : current.direction === "desc" ? ", sorted biggest first" : ", sorted smallest first"
  const hint = current === null ? `Sort by ${label.toLowerCase()}`
    : current.direction === "desc" ? "Biggest first. Click for smallest first"
    : "Smallest first. Click to go back to the default order"
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      disabled={disabled}
      className={`${className} group/th cursor-pointer select-none uppercase transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${current ? "text-foreground" : ""}`}
      aria-label={`${label}${state}`}
      title={disabled ? "Not available until the marks are loaded" : hint}
    >
      <span className="inline-flex items-center">
        <Arrow className={`mr-1 h-3 w-3 shrink-0 ${current ? "text-primary" : "opacity-20 transition-opacity group-hover/th:opacity-60"}`} />
        {label}
      </span>
    </button>
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
  const [stopped, setStopped] = useState(false)
  const [importedWindow, setImportedWindow] = useState<ImportedWindowValue>(EMPTY_IMPORTED_WINDOW)
  // The column the table is sorted by (null: the default order). It is a way of looking at the rows, so counting again keeps it.
  const [sort, setSort] = useState<SiteSort | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // The marks (design: docs/superpowers/specs/2026-10-29-site-marks-design.md): kept per site on the server, shown beside the counts, and read here
  // through a store that orders the saves and puts a failed one back.
  const marksStore = useMemo(
    () => createSiteMarksStore({
      fetch: (input, init) => fetch(input, init),
      onSaveFailed: message => toast({ title: "The mark was not saved", description: message, variant: "destructive" }),
    }),
    [toast],
  )
  const marksSnap = useSyncExternalStore(marksStore.subscribe, marksStore.getSnapshot, marksStore.getSnapshot)
  // The chip that narrows the table by mark. Like the sort, it is a way of looking at the rows, so counting again keeps it.
  const [markFilter, setMarkFilter] = useState<MarkFilter>("all")

  const sites = parseBatchText(rawInput)
  const overLimit = sites.length > SITE_COUNTS_MAX_PER_LIST
  const importedAfterIso = localToUtcIso(importedWindow.after)
  const importedBeforeIso = localToUtcIso(importedWindow.before)
  // What each row can show of its mark. While the marks are not loaded none can, and nothing is filtered by mark, or the table would empty itself.
  const marksLoaded = marksSnap.status === "ready"
  const markStateOfRow = (row: CountRow): MarkState => markStateOf(row.result.host, marksSnap.marks, marksLoaded)
  const effectiveFilter: MarkFilter = marksLoaded ? markFilter : "all"
  const markAvailability = marksSnap.status === "ready" ? "ready" : marksSnap.status === "failed" ? "failed" : "loading"
  // The rows as the table shows them, which is also the order and the content of the CSV: sorted, then narrowed by the mark chip.
  const ordered = orderSiteRows(rows, sort, row => markRank(markStateOfRow(row)))
  const shown = ordered.filter(row => matchesMarkFilter(markStateOfRow(row), effectiveFilter))
  const chipCounts = markFilterCounts(rows.map(markStateOfRow))
  const onSort = (key: SiteSortKey) => setSort(current => nextSiteSort(current, key))
  const onMarkChange = (host: string, patch: SiteMarkPatch) => { void marksStore.change(host, patch) }

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
    setStopped(false)
    setRows([])
    setSubdomainsCounted(true)
    setProgress({ done: 0, total: sites.length })
    // The marks of the whole list, asked for once alongside the first request, so a row arrives with its mark.
    void marksStore.load(planSites(sites).hosts)
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
      if (err instanceof DOMException && err.name === "AbortError") {
        setStopped(true)
      } else {
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
    const blob = new Blob([siteCountsCsv(shown)], { type: "text/csv" })
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

      {/* Side by side from 1024 px; below it the list sits above the counts, so the site names keep their width. */}
      <div className="flex flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        {/* ── Left panel: the list ── */}
        <div
          className="w-full shrink-0 border-b lg:w-80 lg:border-b-0 lg:border-r flex flex-col p-4 gap-3"
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
                Sites or URLs (one per line)
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
                  onClick={() => { setRawInput(""); setFileName(null); setRows([]); setStopped(false) }}
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
            Declutter and Unique are not applied, so a search on the Credentials page can show fewer rows (Declutter hides .php pages, IP hosts and ports).
          </p>
        </div>

        {/* ── Right panel: the counts ── */}
        <div className="flex-1 p-4 lg:overflow-auto">
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

              {stopped && (
                <p className="text-xs text-muted-foreground">
                  Stopped after {progress.done.toLocaleString()} of {progress.total.toLocaleString()} sites. Count again to finish the list.
                </p>
              )}

              {!subdomainsCounted && (
                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Only each site&apos;s own host could be counted right now (the index that finds subdomains is being rebuilt), so these numbers leave subdomains out. Count again in a few minutes.
                  </p>
                </div>
              )}

              {marksSnap.status === "failed" && (
                <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2" role="alert">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                  <p className="flex-1 text-[11px] text-amber-700 dark:text-amber-400">
                    The marks could not be loaded ({marksSnap.error}). The counts are fine; marking, the mark filter and the sort by mark are off until they load.
                  </p>
                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void marksStore.retry()}>Retry</Button>
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
                    <Download className="mr-1.5 h-3.5 w-3.5" />Export CSV{effectiveFilter !== "all" ? ` (${shown.length.toLocaleString()})` : ""}
                  </Button>
                </div>
              )}

              {rows.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap">
                  <SiteMarkFilter value={effectiveFilter} counts={chipCounts} disabled={!marksLoaded} onChange={setMarkFilter} />
                  {effectiveFilter !== "all" && (
                    <span className="text-xs text-muted-foreground">
                      Showing {shown.length.toLocaleString()} of {rows.length.toLocaleString()} ·{" "}
                      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setMarkFilter("all")}>Show all</button>
                    </span>
                  )}
                </div>
              )}

              {rows.length > 0 && (
                <div className="flex items-center gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span className="min-w-0 flex-1">Site</span>
                  <SortHeader label="Mark" sortKey="mark" sort={sort} onSort={onSort} className={COLS.mark} disabled={!marksLoaded} />
                  <SortHeader label="Rows" sortKey="count" sort={sort} onSort={onSort} className={COLS.rows} />
                  <SortHeader label="On the site" sortKey="host_count" sort={sort} onSort={onSort} className={COLS.host} />
                  <SortHeader label="On subdomains" sortKey="subdomain_count" sort={sort} onSort={onSort} className={COLS.subs} />
                  <SortHeader label="Subdomains" sortKey="subdomains" sort={sort} onSort={onSort} className={COLS.distinct} />
                  <span className={COLS.chevron} />
                </div>
              )}

              <div className="flex flex-col gap-2">
                {shown.map(row => (
                  <SiteRow
                    key={row.site}
                    row={row}
                    mark={marksSnap.marks[row.result.host] ?? null}
                    availability={markAvailability}
                    onMarkChange={onMarkChange}
                  />
                ))}
                {rows.length > 0 && shown.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No sites with this mark.{" "}
                    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setMarkFilter("all")}>Show all</button>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
