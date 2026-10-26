"use client"
export const dynamic = "force-dynamic"

import { useState, useRef } from "react"
import {
  Search, Copy, Loader2, X, Download, CheckCircle2, XCircle,
  Hash, Globe, ChevronDown, ChevronUp, AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { localToUtcIso } from "@/lib/imported-window"
import { ImportedWindowFilter, EMPTY_IMPORTED_WINDOW, type ImportedWindowValue } from "@/components/imported-window-filter"
import { BATCH_MAX_QUERIES, buildBatchRequest, suggestBatchKind, type BatchKind } from "@/lib/batch-input"

// ── Types ─────────────────────────────────────────────────────────────────────

interface CredRow {
  email: string
  password: string
  url: string
  domain: string
  source_file: string
  breach_name: string
  imported_at: string
}

interface QueryResult {
  found: boolean
  count: number
  results: CredRow[]
  /** What was looked up when it is not what was pasted (a URL's host, the address inside <...>). */
  searched_as?: string
}

interface BatchResponse {
  success: boolean
  queried: number
  found: number
  results: Record<string, QueryResult>
  error?: string
}

// ── Collapsed result row ──────────────────────────────────────────────────────

function ResultBlock({ query, res, onCopy }: {
  query: string
  res: QueryResult
  onCopy: (text: string, label: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => res.found && setOpen(o => !o)}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          res.found ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        }`}
      >
        {res.found
          ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
          : <XCircle       className="h-4 w-4 shrink-0 text-muted-foreground" />
        }
        <span className="flex-1 font-mono text-xs truncate">{query}</span>
        {res.searched_as && (
          <span className="text-[10px] text-muted-foreground shrink-0 max-w-[40%] truncate" title={`Looked up as ${res.searched_as}`}>
            as {res.searched_as}
          </span>
        )}
        {res.found && (
          <Badge variant="secondary" className="text-xs shrink-0">
            {res.count} hit{res.count !== 1 ? "s" : ""}
          </Badge>
        )}
        {!res.found && (
          <span className="text-xs text-muted-foreground shrink-0">not found</span>
        )}
        {res.found && (
          open
            ? <ChevronUp   className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* Expanded rows */}
      {open && res.results.length > 0 && (
        <div className="border-t overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Email</th>
                <th className="px-3 py-1.5 font-medium">Password</th>
                <th className="px-3 py-1.5 font-medium">Domain</th>
                <th className="px-3 py-1.5 font-medium">Breach</th>
                <th className="px-3 py-1.5 font-medium">Imported</th>
                <th className="px-3 py-1.5 w-8" />
              </tr>
            </thead>
            <tbody>
              {res.results.map((r, i) => (
                <tr key={i} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-1.5 font-mono max-w-[180px] truncate">{r.email}</td>
                  <td className="px-3 py-1.5 font-mono max-w-[140px] truncate">{r.password}</td>
                  <td className="px-3 py-1.5 font-mono max-w-[120px] truncate">{r.domain}</td>
                  <td className="px-3 py-1.5 max-w-[120px] truncate text-muted-foreground">{r.breach_name || "—"}</td>
                  <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                    {r.imported_at ? new Date(r.imported_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      title="Copy email:password"
                      onClick={() => onCopy(`${r.email}:${r.password}`, "credential")}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.count > res.results.length && (
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t bg-muted/20">
              Showing {res.results.length} of {res.count} — use the API for full export
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LookupPage() {
  useAuth(true)
  const { toast } = useToast()

  const [rawInput, setRawInput]   = useState("")
  // What a line that is neither an address nor a URL is looked up as. Suggested from the paste until the person picks one.
  const [mode, setMode]           = useState<BatchKind>("email")
  const [modeChosen, setModeChosen] = useState(false)
  const [loading, setLoading]     = useState(false)
  const [response, setResponse]   = useState<BatchResponse | null>(null)
  const textareaRef               = useRef<HTMLTextAreaElement>(null)

  // Each line is an e-mail or a domain by what it looks like (an address, a URL), so one paste can hold both.
  const lists = buildBatchRequest(rawInput, mode)
  const queryCount = lists.emails.length + lists.domains.length
  const overLimit = queryCount > BATCH_MAX_QUERIES
  const many = queryCount !== 1
  const entryNoun = lists.domains.length === 0 ? (many ? "emails" : "email")
    : lists.emails.length === 0 ? (many ? "domains" : "domain")
    : (many ? "entries" : "entry")
  // Optional: only matches imported in this window. The fields are local time; the API takes the UTC instants shown beneath them.
  const [importedWindow, setImportedWindow] = useState<ImportedWindowValue>(EMPTY_IMPORTED_WINDOW)
  const importedAfterIso = localToUtcIso(importedWindow.after)
  const importedBeforeIso = localToUtcIso(importedWindow.before)

  async function runLookup() {
    if (queryCount === 0 || loading) return
    setLoading(true)
    setResponse(null)
    try {
      const bound = {
        ...(importedAfterIso ? { imported_after: importedAfterIso } : {}),
        ...(importedBeforeIso ? { imported_before: importedBeforeIso } : {}),
      }
      const body = {
        ...(lists.emails.length > 0 ? { emails: lists.emails } : {}),
        ...(lists.domains.length > 0 ? { domains: lists.domains } : {}),
        ...bound,
      }

      const res  = await fetch("/api/lookup/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json: BatchResponse = await res.json()
      if (!json.success) throw new Error(json.error || "Lookup failed")
      setResponse(json)
    } catch (err) {
      toast({
        title: "Lookup failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text)
    toast({ title: `${label} copied` })
  }

  function downloadCSV() {
    if (!response) return
    const rows: string[] = ["query,found,email,password,domain,breach,imported_at"]
    for (const [query, res] of Object.entries(response.results)) {
      if (!res.found) {
        rows.push(`${JSON.stringify(query)},false,,,,, `)
      } else {
        for (const r of res.results) {
          rows.push([
            JSON.stringify(query),
            "true",
            JSON.stringify(r.email),
            JSON.stringify(r.password),
            JSON.stringify(r.domain),
            JSON.stringify(r.breach_name),
            r.imported_at,
          ].join(","))
        }
      }
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `lookup-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Suggest the mode from what is pasted, until the person picks one (an explicit pick is not undone by the next keystroke).
  function handleInput(val: string) {
    setRawInput(val)
    if (!modeChosen && val.trim()) setMode(suggestBatchKind(val))
  }

  function chooseMode(next: BatchKind) {
    setMode(next)
    setModeChosen(true)
  }

  const foundCount = response ? response.found : 0
  const queriedCount = response ? response.queried : 0

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-5">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Search className="h-5 w-5 text-primary" />
          Batch Lookup
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Paste up to {BATCH_MAX_QUERIES} emails, domains or URLs — one per line, mixed is fine — and get instant results
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left panel: input ── */}
        <div className="w-80 shrink-0 border-r flex flex-col p-4 gap-3">
          {/* Mode toggle */}
          <div className="flex items-center gap-1 p-0.5 bg-muted rounded-md">
            <button
              onClick={() => chooseMode("email")}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded transition-colors ${
                mode === "email"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Hash className="h-3 w-3" />
              Email
            </button>
            <button
              onClick={() => chooseMode("domain")}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded transition-colors ${
                mode === "domain"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Globe className="h-3 w-3" />
              Domain
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground -mt-1.5">
            Addresses and URLs are recognised line by line; a plain line is looked up as {mode === "email" ? "an email or username" : "a domain"}.
          </p>

          {/* Textarea */}
          <div className="flex-1 flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Emails, domains or URLs{" "}(one per line, max {BATCH_MAX_QUERIES})
            </label>
            <Textarea
              ref={textareaRef}
              value={rawInput}
              onChange={e => handleInput(e.target.value)}
              placeholder={mode === "email"
                ? "alice@example.com\nbob@corp.io\nhttps://corp.io/login\n..."
                : "example.com\nhttps://www.corp.io/login\nalice@example.com\n..."}
              className="flex-1 resize-none font-mono text-xs min-h-[200px]"
              spellCheck={false}
            />
            <div className="flex items-center justify-between">
              <span className={`text-[10px] ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                {queryCount} / {BATCH_MAX_QUERIES} queries
                {lists.emails.length > 0 && lists.domains.length > 0 && ` (${lists.emails.length} email, ${lists.domains.length} domain)`}
                {overLimit && " — too many"}
              </span>
              {rawInput && (
                <button
                  onClick={() => { setRawInput(""); setResponse(null) }}
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

          {overLimit && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 p-2">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
              <p className="text-[11px] text-destructive">
                Remove {queryCount - BATCH_MAX_QUERIES} entr{queryCount - BATCH_MAX_QUERIES === 1 ? "y" : "ies"} to continue.
              </p>
            </div>
          )}

          <Button
            onClick={runLookup}
            disabled={queryCount === 0 || overLimit || loading}
            className="w-full"
          >
            {loading
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Looking up…</>
              : <><Search  className="mr-2 h-4 w-4" />Look up {queryCount > 0 ? queryCount : ""} {entryNoun}</>
            }
          </Button>
        </div>

        {/* ── Right panel: results ── */}
        <div className="flex-1 overflow-auto p-4">
          {!response && !loading && (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              Paste queries on the left and click Look up
            </div>
          )}

          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-5 w-5 animate-spin" />
              Querying {queryCount} {queryCount === 1 ? "entry" : "entries"}…
            </div>
          )}

          {response && (
            <div className="flex flex-col gap-3">
              {/* Summary bar */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {queriedCount} queried
                  </Badge>
                  <Badge
                    variant={foundCount > 0 ? "destructive" : "outline"}
                    className={foundCount === 0 ? "text-green-600 border-green-500/50" : ""}
                  >
                    {foundCount} found
                  </Badge>
                  <Badge variant="outline">
                    {queriedCount - foundCount} clean
                  </Badge>
                </div>
                {foundCount > 0 && (
                  <Button size="sm" variant="outline" onClick={downloadCSV}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Export CSV
                  </Button>
                )}
              </div>

              {/* Result blocks */}
              <div className="flex flex-col gap-2">
                {Object.entries(response.results)
                  .sort(([, a], [, b]) => Number(b.found) - Number(a.found))
                  .map(([query, res]) => (
                    <ResultBlock
                      key={query}
                      query={query}
                      res={res}
                      onCopy={copy}
                    />
                  ))
                }
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
