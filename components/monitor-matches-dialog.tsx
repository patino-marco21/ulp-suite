"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { formatRelativeTime } from "@/lib/format-relative-time"
import type { MonitorMatchTarget, MonitorMatchRow } from "@/hooks/useMonitorMatches"

interface MonitorMatchesDialogProps {
  monitor: MonitorMatchTarget | null
  matches: MonitorMatchRow[]
  loading: boolean
  limited: boolean
  newCount: number
  error: string | null
  checkedAt: string | null
  neverScanned: boolean
  lastError: string | null
  rescanning: boolean
  onRescan: () => void
  onClose: () => void
}

function freshnessText(checkedAt: string | null, neverScanned: boolean, lastError: string | null): string {
  if (neverScanned) return "Not yet scanned."
  if (lastError) {
    return checkedAt
      ? `Last check failed: ${lastError} — showing results from ${formatRelativeTime(checkedAt)}.`
      : `Last check failed: ${lastError}`
  }
  return checkedAt ? `Last checked ${formatRelativeTime(checkedAt)}.` : ""
}

export function MonitorMatchesDialog({
  monitor, matches, loading, limited, newCount, error,
  checkedAt, neverScanned, lastError, rescanning, onRescan, onClose,
}: MonitorMatchesDialogProps) {
  return (
    <Dialog open={monitor !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4">
            <DialogTitle>Matches — {monitor?.name}</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={onRescan}
              disabled={rescanning || loading}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${rescanning ? 'animate-spin' : ''}`} />
              Rescan now
            </Button>
          </div>
          <DialogDescription>
            {!error && freshnessText(checkedAt, neverScanned, lastError)}
            {!error && newCount > 0 && ` ${newCount} new since your last view.`}
            {!error && limited && ` Showing first ${matches.length} — more may exist.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            /* Must come before the empty-state branch: a failed request is not
               evidence of zero matches, and rendering "No current matches"
               for one is an authoritative false negative. */
            <Alert variant="destructive" className="my-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : neverScanned ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Not yet scanned — click &quot;Rescan now&quot; to check.
            </p>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No current matches.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 font-medium">URL</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Password</th>
                  <th className="px-3 py-2 font-medium">Domain</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m, i) => (
                  <tr key={i} className="border-b hover:bg-muted/40">
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted-foreground" title={m.url}>{m.url}</td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs" title={m.email}>{m.email}</td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs font-medium" title={m.password}>{m.password}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="text-xs font-normal">{m.domain}</Badge>
                      {m.is_new && (
                        <Badge className="text-xs font-normal ml-1.5 bg-primary/10 text-primary border-primary/20">NEW</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
