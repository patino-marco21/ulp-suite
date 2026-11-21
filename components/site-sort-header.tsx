"use client"

import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react"
import type { SiteSort, SiteSortKey } from "@/lib/site-counts-input"

/**
 * The header of a sortable column, as a button: its arrow says whether the table is sorted by the column and which way (the Credentials headers look the
 * same). Off while there is nothing to sort by (the Mark column before the marks are loaded). Used by the Site Counts page and the Site Directory.
 */
export function SortHeader({ label, sortKey, sort, onSort, className, disabled = false }: {
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
