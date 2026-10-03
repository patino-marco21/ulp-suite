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
  // Backups: SQLite snapshots (the app's own job) and the last ClickHouse backup scripts/clickhouse-backup.sh
  // recorded; lastAt null means none has ever been recorded.
  backup?: {
    sqlite: { lastAt: string | null; ageHours: number | null; stale: boolean }
    clickhouse: { lastAt: string | null; ageHours: number | null; stale: boolean; offHost: boolean | null }
    maxAgeHours: number
  }
  // Free space on the ClickHouse data disk; status is ok / warn / critical, or unknown when unreadable.
  disk?: {
    status: "ok" | "warn" | "critical" | "unknown"
    freeBytes: number | null
    totalBytes: number | null
    freeRatio: number | null
    error?: string
  }
  // The two derived tables behind the fast domain search (lib/search-dictionary.ts).
  searchDictionary?: {
    state: "fresh" | "stale" | "missing" | "building" | "disabled" | "unknown"
    builtAt: string | null
    pairRows: number | null
    emailRows: number | null
    bytes: number | null
    lastError: string | null
    lastBuildMs: number | null
  }
}

const fmtRate = (n: number) =>
  n >= 1e8 ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M/s` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K/s` : `${n}/s`
const fmtRows = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n)
const fmtGB = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`
const fmtAge = (h: number) => (h < 1 ? "just now" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`)

function dictionaryLabel(d: NonNullable<IngestHealth["searchDictionary"]>): { text: string; ok: boolean } {
  const ageHours = d.builtAt ? Math.max(0, (Date.now() - Date.parse(d.builtAt)) / 3_600_000) : null
  switch (d.state) {
    case "fresh":
      return { ok: true, text: `Search dictionary: fresh${ageHours !== null && Number.isFinite(ageHours) ? `, built ${fmtAge(ageHours)}` : ""}${d.bytes !== null ? `, ${fmtGB(d.bytes)}` : ""}` }
    case "building":
      return { ok: false, text: "Search dictionary: building — domain searches use the slower query until it is done" }
    case "stale":
      return { ok: false, text: "Search dictionary: stale — domain searches use the slower query until it is rebuilt" }
    case "missing":
      return { ok: false, text: "Search dictionary: missing — domain searches use the slower query (build it: scripts/build-search-dictionary.ts)" }
    case "disabled":
      return { ok: true, text: "Search dictionary: off (SEARCH_DICTIONARY=0)" }
    default:
      return { ok: false, text: "Search dictionary: state unavailable" }
  }
}

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
  const { app, clickhouse, diskBudget, disk, backup, searchDictionary } = data
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
          {disk && (
            <div
              className="flex items-center gap-1.5"
              title={disk.error ?? "Free space on the ClickHouse data disk"}
              data-testid="disk-free"
            >
              <HardDrive className={`h-3.5 w-3.5 ${disk.status === "critical" ? "text-red-600" : disk.status === "warn" ? "text-amber-600" : "text-muted-foreground"}`} />
              <span className={disk.status === "critical" ? "text-red-600 font-medium" : disk.status === "warn" ? "text-amber-600 font-medium" : ""}>
                {disk.freeBytes === null || disk.freeRatio === null
                  ? "disk free: unknown"
                  : `${fmtGB(disk.freeBytes)} free (${Math.round(disk.freeRatio * 100)}%)${disk.status === "critical" ? " — critical" : disk.status === "warn" ? " — low" : ""}`}
              </span>
            </div>
          )}
          {clickhouse.note && <span className="text-xs text-muted-foreground">({clickhouse.note})</span>}
        </div>
        {backup && (
          <div className="flex gap-6 flex-wrap text-xs border-t pt-3" data-testid="backup-status">
            <span
              className={backup.clickhouse.lastAt === null || backup.clickhouse.stale || backup.clickhouse.offHost === false ? "text-amber-600 font-medium" : "text-muted-foreground"}
              title="Credential data (ClickHouse). Run ./scripts/clickhouse-backup.sh; see docs/clickhouse-backup-runbook.md"
            >
              {backup.clickhouse.lastAt === null || backup.clickhouse.ageHours === null
                ? "No ClickHouse backup recorded"
                : `ClickHouse backup ${fmtAge(backup.clickhouse.ageHours)}${backup.clickhouse.offHost ? " (off-host)" : " (this disk only)"}${backup.clickhouse.stale ? " — stale" : ""}`}
            </span>
            <span
              className={backup.sqlite.lastAt === null || backup.sqlite.stale ? "text-amber-600 font-medium" : "text-muted-foreground"}
              title="Users, API keys and monitors (SQLite), snapshotted by the app into data/backups"
            >
              {backup.sqlite.lastAt === null || backup.sqlite.ageHours === null
                ? "No SQLite snapshot yet"
                : `SQLite snapshot ${fmtAge(backup.sqlite.ageHours)}${backup.sqlite.stale ? " — stale" : ""}`}
            </span>
          </div>
        )}
        {searchDictionary && (() => {
          const label = dictionaryLabel(searchDictionary)
          return (
            <div className="flex gap-6 flex-wrap text-xs border-t pt-3" data-testid="search-dictionary">
              <span
                className={label.ok ? "text-muted-foreground" : "text-amber-600 font-medium"}
                title="Two small derived tables that make a one-domain search fast; rebuilt automatically after imports (README, Domain search dictionary)"
              >
                {label.text}
              </span>
              {searchDictionary.lastError && (
                <span className="text-red-600" title={searchDictionary.lastError}>last build failed</span>
              )}
            </div>
          )
        })()}
      </CardContent>
    </Card>
  )
}
