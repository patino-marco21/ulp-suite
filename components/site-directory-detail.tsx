"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BreakdownBar, BreakdownLegend } from "@/components/breakdown-bar"
import { formatRelativeTime } from "@/lib/format-relative-time"
import { breakdownNote, type DirectorySite } from "@/lib/site-directory-input"

/** What the page knows about one row beyond the site: whether its split is being worked out or failed, and whether it is being counted again. */
export interface RowUi {
  breakdown: "idle" | "working" | "failed"
  error: string | null
  recounting: boolean
}

export const IDLE_UI: RowUi = { breakdown: "idle", error: null, recounting: false }

/** The wait for a split. A very broad site takes several seconds, so after four the note says so; it owns its timer so the page does not render for it. */
function WorkingNote() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(id)
  }, [])
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />Working out the split…{slow ? " A very broad site takes several seconds." : ""}
    </p>
  )
}

interface SiteDirectoryDetailProps {
  site: DirectorySite
  ui: RowUi
  onBreakdown: () => void
  onRecount: () => void
  onRemove: () => void
}

/** What an opened directory row adds to the Site Counts detail: when the numbers were taken, the split by login type, the site's history and its actions. */
export function SiteDirectoryDetail({ site, ui, onBreakdown, onRecount, onRemove }: SiteDirectoryDetailProps) {
  const [armed, setArmed] = useState(false)
  const note = breakdownNote(site)
  const { breakdown } = site

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        {site.counted_at ? `Counted ${formatRelativeTime(site.counted_at)}` : "Not counted yet. The next refresh counts it."}
        {site.count_error && !site.counted_at ? ` (${site.count_error})` : ""}
      </p>

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Logins by type</p>
        {site.count === 0 && <p className="text-xs text-muted-foreground">No rows, so nothing to split.</p>}
        {site.count !== 0 && ui.breakdown === "working" && <WorkingNote />}
        {site.count !== 0 && ui.breakdown !== "working" && breakdown && (
          <div className="space-y-2">
            <BreakdownBar breakdown={breakdown} className="h-2.5" />
            <BreakdownLegend breakdown={breakdown} />
            <p className="text-[11px] text-muted-foreground">
              Worked out {formatRelativeTime(breakdown.at)}.{note ? ` ${note}` : ""}
            </p>
          </div>
        )}
        {ui.breakdown === "failed" && (
          <div className="flex flex-wrap items-center gap-2" role="alert">
            <span className="text-xs text-amber-600 dark:text-amber-400">{ui.error ?? "The split could not be worked out."}</span>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={onBreakdown}>Try again</Button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Added {formatRelativeTime(site.first_added_at)} · counted {site.times_counted.toLocaleString()} time{site.times_counted === 1 ? "" : "s"}
        {site.last_counted_at ? ` · last ${formatRelativeTime(site.last_counted_at)}` : ""}
      </p>

      {site.mark?.note && (
        <p className="text-xs"><span className="text-muted-foreground">Note: </span>{site.mark.note}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={ui.recounting} onClick={onRecount}>
          {ui.recounting && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}Recount
        </Button>
        {armed ? (
          <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={onRemove} onBlur={() => setArmed(false)} autoFocus>Click again to remove</Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => setArmed(true)}>Remove</Button>
        )}
      </div>
    </div>
  )
}
