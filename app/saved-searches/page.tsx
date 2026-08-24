"use client"

import { useState, useEffect, useCallback } from "react"
import { Bookmark, Globe, RefreshCw, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"
import { useMonitorMatches } from "@/hooks/useMonitorMatches"
import { MonitorMatchesDialog } from "@/components/monitor-matches-dialog"
import { formatRelativeTime } from "@/lib/format-relative-time"

interface SavedSearch {
  id: number
  name: string
  domains: string[]
  match_mode: "credential" | "url" | "both"
  last_viewed_at: string | null
}

export default function SavedSearchesPage() {
  const { user, loading: authLoading } = useAuth(true)
  const { toast } = useToast()

  const [searches, setSearches] = useState<SavedSearch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const {
    matchesMonitor, matches, matchesLoading, matchesLimited, matchesNewCount, matchesError,
    openMatches, closeMatches,
  } = useMonitorMatches()

  const fetchSearches = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch("/api/monitoring/monitors?active_only=true", { credentials: "include", cache: "no-store" })
      const data = await res.json()
      if (data.success) {
        setSearches(data.data || [])
      } else {
        setError(data.error || "Failed to load saved searches")
        toast({ variant: "destructive", title: "Error", description: data.error || "Failed to load saved searches" })
      }
    } catch (_error) {
      setError("Failed to load saved searches")
      toast({ variant: "destructive", title: "Error", description: "Failed to load saved searches" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (!authLoading && user) fetchSearches()
  }, [authLoading, user, fetchSearches])

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <main className="flex-1 p-6 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Bookmark className="h-7 w-7 text-primary" />
              </div>
              Saved Searches
            </h1>
            <p className="text-muted-foreground">
              Credentials currently matching your team&apos;s monitored domains, queried live.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchSearches}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        ) : searches.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Bookmark className="h-12 w-12 mx-auto text-muted-foreground opacity-30 mb-4" />
              <p className="text-muted-foreground">No saved searches yet — ask an admin to set one up in Domain Monitoring.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {searches.map(search => (
              <Card key={search.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-lg">{search.name}</CardTitle>
                      <Badge variant="outline">
                        {search.match_mode === "both" ? "Email + URL" : search.match_mode === "credential" ? "Email Only" : "URL Only"}
                      </Badge>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => openMatches(search)}>
                      <Search className="h-4 w-4 mr-1.5" />
                      View Matches
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {search.domains.map((domain, i) => (
                      <Badge key={i} variant="outline" className="gap-1">
                        <Globe className="h-3 w-3" />
                        {domain}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {search.last_viewed_at ? formatRelativeTime(search.last_viewed_at) : "Never viewed"}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <MonitorMatchesDialog
        monitor={matchesMonitor}
        matches={matches}
        loading={matchesLoading}
        limited={matchesLimited}
        newCount={matchesNewCount}
        error={matchesError}
        onClose={closeMatches}
      />
    </main>
  )
}
