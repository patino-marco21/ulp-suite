"use client"
export const dynamic = "force-dynamic"

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { AlertTriangle, Library, Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { BreakdownBar } from "@/components/breakdown-bar"
import { ListFooterLine } from "@/components/list-footer-line"
import { COLS, SiteRow } from "@/components/site-count-row"
import { IDLE_UI, SiteDirectoryDetail, type RowUi } from "@/components/site-directory-detail"
import { SiteMarkFilter } from "@/components/site-mark-filter"
import { SortHeader } from "@/components/site-sort-header"
import { LOAD_AHEAD_PX, listFooter, scrollParentOf, shouldAutoLoad } from "@/lib/credential-pages"
import { nextSiteSort, type SiteSort, type SiteSortKey } from "@/lib/site-counts-input"
import {
  directoryParams, directoryResult, needsBreakdown, statusLine, type DirectoryListing, type DirectorySite, type DirectoryStatus,
} from "@/lib/site-directory-input"
import { createSiteMarksStore } from "@/lib/site-marks-client"
import type { MarkFilter, SiteMark, SiteMarkPatch } from "@/lib/site-marks-input"

const SESSION_EXPIRED = "Your session has expired. Sign in again, then reload."
const ZERO_CHIPS: Record<MarkFilter, number> = { all: 0, done: 0, skip: 0, todo: 0, none: 0 }

type Answer<T> = T & { success?: boolean; error?: string }

/** A JSON answer of a session route. An expired session is redirected to the sign-in page, which is not JSON. */
async function getJson<T>(url: string, init?: RequestInit): Promise<Answer<T>> {
  const res = await fetch(url, init)
  if (res.redirected || res.status === 401) throw new Error(SESSION_EXPIRED)
  return await res.json()
}

const marksOf = (sites: DirectorySite[]): Record<string, SiteMark> =>
  Object.fromEntries(sites.filter(s => s.mark !== null).map(s => [s.host, s.mark as SiteMark]))

/**
 * Back to the top of the list when it is replaced (a sort, a search, a chip, a reload). In this layout the whole document scrolls, so the list's own box is
 * not what scrolls; a box that does scroll, or an ancestor that does, is honoured too. Without it a list replaced while the person is far down keeps the
 * old scroll position, the end of the new first page is then in range of the observer, and every page is fetched again.
 */
function scrollListToTop(box: HTMLElement | null) {
  const scroller = box && box.scrollHeight > box.clientHeight + 1 ? box : box ? scrollParentOf(box) : null
  if (scroller) scroller.scrollTo({ top: 0 })
  else window.scrollTo({ top: 0 })
}

// ── One row ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DirectoryRowProps {
  site: DirectorySite
  mark: SiteMark | null
  ui: RowUi
  onMarkChange: (host: string, patch: SiteMarkPatch) => void
  onOpen: (host: string) => void
  onBreakdown: (host: string) => void
  onRecount: (host: string) => void
  onRemove: (host: string) => void
}

/** Memoised: the list is endless and can hold thousands of rows, and a poll of the status, a click on another row or a page appended must not render them all. */
const DirectoryRow = memo(function DirectoryRow({ site, mark, ui, onMarkChange, onOpen, onBreakdown, onRecount, onRemove }: DirectoryRowProps) {
  const row = useMemo(() => ({ site: site.host, result: directoryResult(site) }), [site])
  const detail = useMemo(() => ({
    onOpen: () => onOpen(site.host),
    cell: site.breakdown ? <BreakdownBar breakdown={site.breakdown} /> : null,
    body: (
      <SiteDirectoryDetail
        site={site}
        ui={ui}
        onBreakdown={() => onBreakdown(site.host)}
        onRecount={() => onRecount(site.host)}
        onRemove={() => onRemove(site.host)}
      />
    ),
  }), [site, ui, onOpen, onBreakdown, onRecount, onRemove])
  return <SiteRow row={row} mark={mark} availability="ready" onMarkChange={onMarkChange} detail={detail} />
})

// ── Main page ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export default function SiteDirectoryPage() {
  useAuth(true)
  const { toast } = useToast()

  const [rows, setRows] = useState<DirectorySite[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [chips, setChips] = useState<Record<MarkFilter, number> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  // The way the list is looked at. A change of any of the three replaces the list and goes back to the top.
  const [sort, setSort] = useState<SiteSort | null>(null)
  const [markFilter, setMarkFilter] = useState<MarkFilter>("all")
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState("")
  const [status, setStatus] = useState<DirectoryStatus | null>(null)
  const [loadedRefreshedAt, setLoadedRefreshedAt] = useState<string | null>(null)
  const [uiByHost, setUiByHost] = useState<Record<string, RowUi>>({})

  const searchRef = useRef(0) // which list is on screen: an answer for another one is dropped
  const loadAbortRef = useRef<AbortController | null>(null)
  const moreAbortRef = useRef<AbortController | null>(null)
  const moreInFlightRef = useRef(false)
  const shownQueryRef = useRef("") // the query string of the list on screen, without an offset: the next page continues THIS list
  const rowsRef = useRef<DirectorySite[]>([])
  const uiRef = useRef<Record<string, RowUi>>({})
  const listBoxRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // The marks come with the list (a join on the server); the store orders the saves of a change and puts a failed one back.
  const marksStore = useMemo(
    () => createSiteMarksStore({
      fetch: (input, init) => fetch(input, init),
      onSaveFailed: message => toast({ title: "The mark was not saved", description: message, variant: "destructive" }),
    }),
    [toast],
  )
  const marksSnap = useSyncExternalStore(marksStore.subscribe, marksStore.getSnapshot, marksStore.getSnapshot)

  useEffect(() => { rowsRef.current = rows }, [rows])
  useEffect(() => {
    const id = setTimeout(() => setApplied(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  const load = useCallback(async () => {
    const id = ++searchRef.current
    loadAbortRef.current?.abort()
    moreAbortRef.current?.abort()
    moreInFlightRef.current = false
    const controller = new AbortController()
    loadAbortRef.current = controller
    setLoading(true)
    setLoadingMore(false)
    setMoreError(null)
    setLoadError(null)
    const base = directoryParams({ sort, q: applied, mark: markFilter })
    shownQueryRef.current = base.toString()
    try {
      const json = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${base.toString()}`, { signal: controller.signal })
      if (id !== searchRef.current) return
      if (!json.success || !json.sites) throw new Error(json.error || "The directory could not be loaded")
      setRows(json.sites)
      setNextOffset(json.next_offset ?? null)
      setTotal(json.total ?? null)
      setChips(json.marks ?? null)
      setLoadedRefreshedAt(json.refreshed_at ?? null)
      marksStore.adopt(marksOf(json.sites), true)
      scrollListToTop(listBoxRef.current)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      if (id !== searchRef.current) return
      setLoadError(err instanceof Error ? err.message : "The directory could not be loaded")
    } finally {
      if (id === searchRef.current) setLoading(false)
    }
  }, [sort, applied, markFilter, marksStore])
  useEffect(() => { void load() }, [load])

  const loadMore = useCallback(async () => {
    if (nextOffset === null || loading || moreInFlightRef.current) return
    moreInFlightRef.current = true
    const id = searchRef.current
    const controller = new AbortController()
    moreAbortRef.current = controller
    setLoadingMore(true)
    setMoreError(null)
    try {
      const ps = new URLSearchParams(shownQueryRef.current)
      ps.set('offset', String(nextOffset))
      const json = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${ps.toString()}`, { signal: controller.signal })
      if (id !== searchRef.current) return
      if (!json.success || !json.sites) throw new Error(json.error || "The next sites could not be loaded.")
      // a site added between two pages can shift the offset: one that is already shown is not shown twice
      setRows(prev => {
        const seen = new Set(prev.map(s => s.host))
        return [...prev, ...json.sites!.filter(s => !seen.has(s.host))]
      })
      setNextOffset(json.next_offset ?? null)
      marksStore.adopt(marksOf(json.sites))
    } catch (err) {
      if (id !== searchRef.current) return
      setMoreError(err instanceof DOMException && err.name === "AbortError" ? 'Stopped.' : err instanceof Error ? err.message : "The next sites could not be loaded.")
    } finally {
      moreInFlightRef.current = false
      if (id === searchRef.current) setLoadingMore(false)
    }
  }, [nextOffset, loading, marksStore])

  // The end of the rows and what scrolls them: when the end comes within LOAD_AHEAD_PX of the bottom of the scroller, the next page is fetched. The observer
  // is made again after every page (and every list), so that a page that does not fill the screen is followed by the next at once.
  const loadMoreRef = useRef(loadMore)
  useEffect(() => { loadMoreRef.current = loadMore }, [loadMore])
  const listState = { rows: rows.length, hasMore: nextOffset !== null, loading, loadingMore, error: moreError !== null }
  const autoLoad = shouldAutoLoad(listState)
  const footerKind = listFooter(listState)
  useEffect(() => {
    const target = sentinelRef.current
    if (!autoLoad || !target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) void loadMoreRef.current() },
      { root: scrollParentOf(target), rootMargin: `0px 0px ${LOAD_AHEAD_PX}px 0px` },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [autoLoad, rows.length])

  // What the line above the list says: asked for every 30 s while the tab is visible. New numbers never move under the cursor: a finished refresh offers a
  // reload.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const json = await getJson<Partial<DirectoryStatus>>("/api/lookup/directory/status")
        if (!cancelled && json.success) setStatus(json as DirectoryStatus)
      } catch {
        // the line keeps its last words
      }
    }
    void poll()
    const id = setInterval(poll, 30_000)
    const onVisible = () => { if (document.visibilityState === "visible") void poll() }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])
  const reloadNeeded = status !== null && status.state === "current" && status.refreshed_at !== loadedRefreshedAt

  // ── Edits that change a row on screen and nothing else ──
  const refreshChips = useCallback(async () => {
    try {
      const json = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${directoryParams({ sort, q: applied, mark: markFilter, limit: 1 }).toString()}`)
      if (json.success) {
        setChips(json.marks ?? null)
        setTotal(json.total ?? null)
      }
    } catch {
      // the chips keep their numbers until the next load
    }
  }, [sort, applied, markFilter])
  const refreshChipsRef = useRef(refreshChips)
  useEffect(() => { refreshChipsRef.current = refreshChips }, [refreshChips])

  const patchUi = useCallback((host: string, patch: Partial<RowUi>) => {
    uiRef.current = { ...uiRef.current, [host]: { ...(uiRef.current[host] ?? IDLE_UI), ...patch } }
    setUiByHost(uiRef.current)
  }, [])
  const replaceSite = useCallback((site: DirectorySite) => {
    setRows(prev => prev.map(s => (s.host === site.host ? site : s)))
  }, [])

  const onMarkChange = useCallback((host: string, patch: SiteMarkPatch) => {
    void marksStore.change(host, patch).then(() => refreshChipsRef.current())
  }, [marksStore])

  const startBreakdown = useCallback(async (host: string) => {
    if (uiRef.current[host]?.breakdown === "working") return
    patchUi(host, { breakdown: "working", error: null })
    try {
      const json = await getJson<{ site?: DirectorySite }>("/api/lookup/directory/breakdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      })
      if (!json.success || !json.site) throw new Error(json.error || "The split could not be worked out")
      replaceSite(json.site)
      patchUi(host, { breakdown: "idle", error: null })
    } catch (err) {
      patchUi(host, { breakdown: "failed", error: err instanceof Error ? err.message : "The split could not be worked out" })
    }
  }, [patchUi, replaceSite])

  // Opening a row with no split works it out: the click is the demand.
  const onOpen = useCallback((host: string) => {
    const site = rowsRef.current.find(s => s.host === host)
    if (site && needsBreakdown(site)) void startBreakdown(host)
  }, [startBreakdown])

  const recount = useCallback(async (host: string) => {
    patchUi(host, { recounting: true })
    try {
      const counted = await getJson<unknown>("/api/lookup/counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: [host] }),
      })
      if (!counted.success) throw new Error(counted.error || "Counting failed")
      const one = await getJson<Partial<DirectoryListing>>(`/api/lookup/directory?${directoryParams({ sort: null, q: "", mark: "all", host }).toString()}`)
      const site = one.sites?.[0]
      if (site) replaceSite(site)
      if (site?.breakdown) await startBreakdown(host)
    } catch (err) {
      toast({ title: "The recount failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    } finally {
      patchUi(host, { recounting: false })
    }
  }, [patchUi, replaceSite, startBreakdown, toast])

  const removeSiteRow = useCallback(async (host: string) => {
    try {
      const json = await getJson<unknown>("/api/lookup/directory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      })
      if (!json.success) throw new Error(json.error || "The site was not removed")
      setRows(prev => prev.filter(s => s.host !== host))
      setTotal(t => (t === null ? t : Math.max(0, t - 1)))
      void refreshChipsRef.current()
    } catch (err) {
      toast({ title: "The site was not removed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }, [toast])

  const onSort = (key: SiteSortKey) => setSort(current => nextSiteSort(current, key))
  const filtered = applied !== "" || markFilter !== "all"

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-5">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Library className="h-5 w-5 text-primary" />
          Site Directory
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every site you have counted, most rows first. Open one to see its count and how its logins split into e-mail, phone, user name and other
        </p>
      </div>

      <div className="border-b px-6 py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sites"
              aria-label="Search the directory"
              className="h-8 pl-7 text-xs"
              spellCheck={false}
            />
          </div>
          <SiteMarkFilter value={markFilter} counts={chips ?? ZERO_CHIPS} disabled={chips === null} onChange={setMarkFilter} />
          {total !== null && (
            <span className="text-xs tabular-nums text-muted-foreground">{total.toLocaleString()} site{total === 1 ? "" : "s"}{filtered ? " match" : ""}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          {status && <span>{statusLine(status)}</span>}
          {reloadNeeded && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void load()}>Reload the list</Button>
          )}
        </div>
      </div>

      <div ref={listBoxRef} className="flex-1 overflow-auto p-4">
        {loadError && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2 mb-3" role="alert">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <p className="flex-1 text-[11px] text-amber-700 dark:text-amber-400">{loadError}</p>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void load()}>Retry</Button>
          </div>
        )}

        {loading && rows.length === 0 && !loadError && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />Loading the directory…
          </div>
        )}

        {!loading && !loadError && rows.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {filtered ? "No sites match." : "No sites yet. Count a list on Site Counts and every site lands here."}
          </p>
        )}

        {rows.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 px-4 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span className="min-w-0 flex-1">Site</span>
              <SortHeader label="Mark" sortKey="mark" sort={sort} onSort={onSort} className={COLS.mark} />
              <SortHeader label="Rows" sortKey="count" sort={sort} onSort={onSort} className={COLS.rows} />
              <SortHeader label="On the site" sortKey="host_count" sort={sort} onSort={onSort} className={COLS.host} />
              <SortHeader label="On subdomains" sortKey="subdomain_count" sort={sort} onSort={onSort} className={COLS.subs} />
              <SortHeader label="Subdomains" sortKey="subdomains" sort={sort} onSort={onSort} className={COLS.distinct} />
              <span className={COLS.split}>Split</span>
              <span className={COLS.chevron} />
            </div>

            <div className="flex flex-col gap-2">
              {rows.map(site => (
                <DirectoryRow
                  key={site.host}
                  site={site}
                  mark={marksSnap.marks[site.host] ?? null}
                  ui={uiByHost[site.host] ?? IDLE_UI}
                  onMarkChange={onMarkChange}
                  onOpen={onOpen}
                  onBreakdown={startBreakdown}
                  onRecount={recount}
                  onRemove={removeSiteRow}
                />
              ))}
            </div>

            <div ref={sentinelRef} aria-hidden="true" className="h-px" />
            <ListFooterLine
              kind={footerKind}
              rows={rows.length}
              error={moreError}
              onLoadMore={loadMore}
              onStop={() => moreAbortRef.current?.abort()}
              noun="sites"
              endLabel="end of the directory"
              slowHint=""
            />
          </div>
        )}
      </div>
    </div>
  )
}
