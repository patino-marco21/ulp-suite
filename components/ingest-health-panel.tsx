"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, Database, GitMerge, Gauge, HardDrive } from "lucide-react"

interface IngestHealth {
  app: {
    filename: string | null
    batchSize: number
    parserRowsPerSec: number
    insertRowsPerSec: number
    lastBatchInsertMs: number
    imported: number
    tierDropped: number
    bottleneck: "parse" | "insert" | null
    updatedAt: number
  }
  clickhouse: {
    activeParts: number
    partsThreshold: number
    activeMerges: number
    memoryBytes: number
    note?: string
  }
  diskBudget: {
    usedBytes: number
    budgetBytes: number
    pct: number
    note?: string
  }
}

const fmtRate = (n: number) =>
  n >= 1e8 ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M/s` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K/s` : `${n}/s`
const fmtRows = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n)
const fmtGB = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`

export function IngestHealthPanel() {
  const [data, setData] = useState<IngestHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch("/api/monitoring/ingest-health", { credentials: "include", cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as IngestHealth
        if (!cancelled) setData(json)
      } catch {
        /* transient — keep last value */
      }
    }
    poll()
    const id = setInterval(poll, 2_500)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!data) return null
  const { app, clickhouse, diskBudget } = data
  const active = app.filename !== null && Date.now() - app.updatedAt < 5_000
  const partsPct = Math.min(100, Math.round((clickhouse.activeParts / clickhouse.partsThreshold) * 100))

  return (
    <Card className="mt-6">
      <CardHeader className="py-3">
        <div className="flex items-center gap-2">
          <Activity className={`h-4 w-4 ${active ? "text-green-500 animate-pulse" : "text-muted-foreground"}`} />
          <CardTitle className="text-base">Ingest Health</CardTitle>
          {active && app.bottleneck && (
            <Badge
              variant="outline"
              className={app.bottleneck === "insert" ? "text-amber-600 border-amber-500/40" : "text-blue-600 border-blue-500/40"}
            >
              {app.bottleneck === "insert" ? "insert-bound" : "parse-bound"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 pb-4 space-y-3 text-sm">
        <div className="flex gap-6 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground">Parser</p>
            <p className={`font-semibold tabular-nums ${active && app.bottleneck === "parse" ? "text-blue-600" : ""}`}>
              {active ? fmtRate(app.parserRowsPerSec) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Insert</p>
            <p className={`font-semibold tabular-nums ${active && app.bottleneck === "insert" ? "text-amber-600" : ""}`}>
              {active ? fmtRate(app.insertRowsPerSec) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Last batch insert</p>
            <p className="font-semibold tabular-nums">{active ? `${app.lastBatchInsertMs}ms` : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Imported / T3-dropped</p>
            <p className="font-semibold tabular-nums">{fmtRows(app.imported)} / {fmtRows(app.tierDropped)}</p>
          </div>
        </div>
        {app.filename && (
          <p className="text-xs font-mono text-muted-foreground truncate" title={app.filename}>{app.filename}</p>
        )}
        <div className="flex gap-6 flex-wrap border-t pt-3">
          <div className="flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <span className={partsPct >= 70 ? "text-red-600 font-medium" : ""}>
              {clickhouse.activeParts} / {clickhouse.partsThreshold} parts
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <GitMerge className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{clickhouse.activeMerges} merges</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{fmtGB(clickhouse.memoryBytes)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
            <span className={diskBudget.pct >= 70 ? "text-red-600 font-medium" : ""}>
              {fmtGB(diskBudget.usedBytes)} / {fmtGB(diskBudget.budgetBytes)} ({diskBudget.pct}%)
            </span>
          </div>
          {clickhouse.note && <span className="text-xs text-muted-foreground">({clickhouse.note})</span>}
        </div>
      </CardContent>
    </Card>
  )
}
