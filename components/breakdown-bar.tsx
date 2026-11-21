import { breakdownShares, type BreakdownCounts } from "@/lib/site-directory-input"

/** A fill per part. Colour is never the only signal: the legend names every part with its count and share, and the bar's accessible name lists them. */
const PART_COLORS: Record<string, string> = {
  email: "bg-sky-500",
  phone: "bg-amber-500",
  username: "bg-emerald-500",
  other: "bg-slate-400",
}

/** The split of a site's logins as one thin stacked bar. */
export function BreakdownBar({ breakdown, className = "h-2" }: { breakdown: BreakdownCounts; className?: string }) {
  const shares = breakdownShares(breakdown)
  const label = shares.map(s => `${s.label} ${s.text}`).join(", ")
  return (
    <div role="img" aria-label={label} title={label} className={`flex w-full overflow-hidden rounded-full bg-muted ${className}`}>
      {shares.filter(s => s.count > 0).map(s => (
        <div key={s.key} className={PART_COLORS[s.key]} style={{ flexGrow: s.count, flexBasis: 0 }} />
      ))}
    </div>
  )
}

/** The four parts with their counts and shares, as text. */
export function BreakdownLegend({ breakdown }: { breakdown: BreakdownCounts }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
      {breakdownShares(breakdown).map(s => (
        <div key={s.key} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${PART_COLORS[s.key]}`} aria-hidden />
          <dt className="text-muted-foreground">{s.label}</dt>
          <dd className="ml-auto tabular-nums sm:ml-1">
            <span className="font-medium">{s.count.toLocaleString()}</span> <span className="text-muted-foreground">{s.text}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}
