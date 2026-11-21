"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ListFooter } from "@/lib/credential-pages"

/**
 * What an endless list says under its rows: that more comes by scrolling, that a page is loading (with the seconds it has taken: a page of a rare search
 * can take a minute, and a spinner alone does not say whether anything is happening) and a button to stop it, a retry after an error or a stop, a button
 * past the row cap, and the end. It owns the seconds counter, so that the table does not render once a second. The Credentials page and the Site
 * Directory use it; the defaults are the Credentials page's words.
 */
export function ListFooterLine({ kind, rows, error, onLoadMore, onStop, noun = "rows", endLabel = "end of the results", slowHint = " (a rare search scans the whole table; a page can take a minute)" }: {
  kind: ListFooter
  rows: number
  error: string | null
  onLoadMore: () => void
  onStop: () => void
  /** What the rows are called ("rows", "sites"). */
  noun?: string
  /** What the end of the list says after the count. */
  endLabel?: string
  /** Appended to the loading line after 15 s; empty for a list whose pages are quick. */
  slowHint?: string
}) {
  const [seconds, setSeconds] = useState(0)
  const loading = kind === 'loading'
  useEffect(() => {
    if (!loading) { setSeconds(0); return }
    const started = Date.now()
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [loading])

  const count = rows.toLocaleString('en-US')
  return (
    <div className="flex items-center justify-center gap-3 border-t px-4 py-3 text-sm text-muted-foreground" role="status" aria-live="polite">
      {kind === 'loading' && (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="tabular-nums">{count} {noun} loaded · loading the next {noun}… {seconds} s{seconds >= 15 ? slowHint : ''}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onStop}>Stop</Button>
        </>
      )}
      {kind === 'error' && (
        <>
          <span className="text-amber-600 dark:text-amber-400">{error ?? `The next ${noun} could not be loaded.`}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onLoadMore}>Retry</Button>
        </>
      )}
      {kind === 'more' && <span className="tabular-nums">{count} {noun} loaded · scroll for more</span>}
      {kind === 'capped' && (
        <>
          <span className="tabular-nums">{count} {noun} loaded</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onLoadMore}>Load the next {noun}</Button>
        </>
      )}
      {kind === 'end' && <span className="tabular-nums">{count} {noun} · {endLabel}</span>}
    </div>
  )
}
