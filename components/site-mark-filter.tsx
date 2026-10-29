"use client"

import { MarkIcon } from "@/components/site-mark-cell"
import { MARK_FILTERS, MARK_FILTER_LABELS, type MarkFilter } from "@/lib/site-marks-input"

interface SiteMarkFilterProps {
  value: MarkFilter
  /** How many rows each chip would show. */
  counts: Record<MarkFilter, number>
  /** The marks are not loaded: every chip but All is off, since nothing can be told apart yet. */
  disabled: boolean
  onChange: (next: MarkFilter) => void
}

/** The chips above the Site Counts table: All, Done, Skip, To look at, No mark, each with the number of rows it shows. */
export function SiteMarkFilter({ value, counts, disabled, onChange }: SiteMarkFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show sites by mark">
      {MARK_FILTERS.map(filter => {
        const active = value === filter
        return (
          <button
            key={filter}
            type="button"
            disabled={disabled && filter !== "all"}
            aria-pressed={active}
            onClick={() => onChange(filter)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              active ? "border-primary bg-muted font-medium" : "hover:bg-muted"
            }`}
          >
            {filter !== "all" && <MarkIcon status={filter === "none" ? null : filter} className="h-3 w-3 shrink-0" />}
            {MARK_FILTER_LABELS[filter]}
            <span className="tabular-nums text-muted-foreground">{counts[filter].toLocaleString()}</span>
          </button>
        )
      })}
    </div>
  )
}
