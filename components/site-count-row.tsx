"use client"

import { useState, type ReactNode } from "react"
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react"
import { MARK_CELL, SiteMarkCell } from "@/components/site-mark-cell"
import type { SiteCount } from "@/lib/site-counts-input"
import { isMarkableHost, type SiteMark, type SiteMarkPatch } from "@/lib/site-marks-input"

export interface CountRow {
  site: string
  result: SiteCount
}

export const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString())

/**
 * The columns after the site name. The mark cell is on screen at every width. The breakdown columns need a wide window (xl); below it the same numbers are
 * in the row's detail. The headers of the number columns and of the mark column are sort buttons, and their widths leave room for the arrow in front of
 * the label. `split` is the Site Directory's column for the bar of a stored split of logins by type.
 */
export const COLS = {
  mark: MARK_CELL,
  rows: "w-20 text-right shrink-0",
  host: "hidden xl:block w-24 text-right shrink-0",
  subs: "hidden xl:block w-28 text-right shrink-0",
  distinct: "hidden xl:block w-24 text-right shrink-0",
  split: "hidden xl:flex w-28 items-center shrink-0",
  chevron: "w-3.5 shrink-0",
}

/**
 * What the Site Directory adds to a row (the Site Counts page passes none): it opens every row, not only those with rows, shows `cell` in the row at
 * wide widths and `body` under the numbers of the detail, and is told when the row is opened.
 */
export interface SiteRowDetail {
  body: ReactNode
  cell?: ReactNode
  onOpen?: () => void
}

interface SiteRowProps {
  row: CountRow
  /** The site's stored mark, null when it has none. */
  mark: SiteMark | null
  availability: "loading" | "ready" | "failed"
  onMarkChange: (host: string, patch: SiteMarkPatch) => void
  detail?: SiteRowDetail
}

export function SiteRow({ row, mark, availability, onMarkChange, detail }: SiteRowProps) {
  const [open, setOpen] = useState(false)
  const { site, result } = row
  const expandable = detail !== undefined || (result.count ?? 0) > 0
  const muted = !result.error && result.count === 0
  const toggle = () => {
    if (!expandable) return
    if (!open) detail?.onOpen?.()
    setOpen(o => !o)
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* A div, not a button: the mark's own button sits inside this row, and a button in a button is not valid HTML. A click anywhere on the row opens its
          detail for the mouse; the chevron is the real button, for the keyboard and for assistive tools. */}
      <div
        onClick={toggle}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          expandable ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="min-w-0 flex-1">
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
        {isMarkableHost(result.host) ? (
          <SiteMarkCell host={result.host} mark={mark} availability={availability} onChange={patch => onMarkChange(result.host, patch)} />
        ) : (
          <span className={COLS.mark} />
        )}
        <span className={`${COLS.rows} text-sm font-semibold tabular-nums ${muted ? "text-muted-foreground font-normal" : ""}`}>{fmt(result.count)}</span>
        <span className={`${COLS.host} text-xs tabular-nums text-muted-foreground`}>{fmt(result.host_count)}</span>
        <span className={`${COLS.subs} text-xs tabular-nums text-muted-foreground`}>{fmt(result.subdomain_count)}</span>
        <span className={`${COLS.distinct} text-xs tabular-nums text-muted-foreground`}>{fmt(result.subdomains)}</span>
        {detail && <span className={COLS.split}>{detail.cell}</span>}
        <span className={COLS.chevron}>
          {expandable && (
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                toggle()
              }}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} the details of ${site}`}
              className="flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          )}
        </span>
      </div>

      {open && expandable && (
        <div className="border-t bg-muted/20 px-4 py-2 space-y-2">
          {result.count !== null && (
            <p className="text-xs text-muted-foreground">
              <span className="tabular-nums">{fmt(result.host_count)}</span> on the site itself
              {result.subdomain_count === null
                ? " · subdomains not counted"
                : <>{" · "}<span className="tabular-nums">{fmt(result.subdomain_count)}</span> on {fmt(result.subdomains)} subdomain{result.subdomains === 1 ? "" : "s"}</>}
            </p>
          )}
          {result.top_subdomains.length > 0 && (
            <div>
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
          {detail?.body}
        </div>
      )}
    </div>
  )
}
