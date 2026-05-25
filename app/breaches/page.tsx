"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import { ShieldAlert, Loader2, Plus, Search, ChevronLeft, ChevronRight, BadgeCheck, Skull, Globe, Users, Cloud } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import Link from "next/link"

interface BreachRow {
  breach_name: string
  title: string
  domain: string
  breach_date: string
  pwn_count: number
  data_classes: string[]
  is_verified: boolean
  is_mega_dump: boolean
  is_stealer_log: boolean
  is_malware: boolean
  credential_count: number
}

interface BreachesResult {
  success: boolean
  breaches: BreachRow[]
  total: number
  page: number
  pages: number
}

function fmtCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function BreachBadges({ b }: { b: BreachRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {b.is_verified && (
        <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-500 py-0">
          <BadgeCheck className="h-2.5 w-2.5 mr-0.5" />Verified
        </Badge>
      )}
      {b.is_mega_dump && (
        <Badge variant="outline" className="text-[10px] border-purple-500/40 text-purple-500 py-0">
          Mega-dump
        </Badge>
      )}
      {b.is_stealer_log && (
        <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500 py-0">
          <Skull className="h-2.5 w-2.5 mr-0.5" />Stealer
        </Badge>
      )}
      {b.is_malware && (
        <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-500 py-0">
          Malware
        </Badge>
      )}
    </div>
  )
}

export default function BreachesPage() {
  useAuth(true)
  const { toast } = useToast()

  const [data, setData] = useState<BreachesResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const load = useCallback(async (p: number, query: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/breaches?page=${p}&limit=50&q=${encodeURIComponent(query)}`)
      const json = await res.json()
      if (json.success) {
        setData(json)
        setPage(p)
      } else throw new Error(json.error)
    } catch {
      toast({ title: "Failed to load breaches", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load(1, '') }, [load])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setQ(searchInput)
    load(1, searchInput)
  }

  const syncHIBP = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/breaches/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (json.success) {
        toast({ title: `HIBP sync complete: ${json.inserted} new, ${json.updated} updated` })
        load(1, q)
      } else {
        toast({ title: `Sync failed: ${json.error}`, variant: "destructive" })
      }
    } catch {
      toast({ title: "HIBP sync failed", variant: "destructive" })
    } finally {
      setSyncing(false)
    }
  }

  const totalTagged = data?.breaches.reduce((s, b) => s + b.credential_count, 0) ?? 0

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-500" />
              Breach Catalog
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Named data breaches — tag credentials at ingest or re-tag existing data
              {data && data.total > 0 && (
                <span className="ml-2 text-xs">
                  · <strong className="text-foreground">{data.total}</strong> breaches ·{' '}
                  <strong className="text-foreground">{fmtCount(totalTagged)}</strong> tagged credentials
                </span>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={syncHIBP}
              disabled={syncing || loading}
            >
              {syncing ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Cloud className="mr-2 h-3.5 w-3.5" />
              )}
              Sync HIBP
            </Button>
            <Button size="sm" asChild>
              <Link href="/breaches/new">
                <Plus className="mr-2 h-3.5 w-3.5" />New
              </Link>
            </Button>
          </div>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="mt-3 flex gap-2 max-w-md">
          <Input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Filter breaches…"
            className="h-8 text-sm"
          />
          <Button type="submit" size="sm" variant="outline">
            <Search className="h-3.5 w-3.5" />
          </Button>
        </form>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && !data && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && (
          <>
            <div className="flex items-center border-b px-4 py-2">
              <span className="text-sm text-muted-foreground">
                {data.total.toLocaleString()} breach{data.total !== 1 ? "es" : ""}
                {q && ` matching "${q}"`}
              </span>
            </div>

            {data.breaches.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center text-muted-foreground text-sm gap-3">
                <p>No breaches in catalog yet.</p>
                <Button size="sm" onClick={syncHIBP} disabled={syncing}>
                  {syncing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Cloud className="mr-2 h-3.5 w-3.5" />}
                  Import from HIBP
                </Button>
              </div>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background border-b">
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Breach</th>
                      <th className="px-4 py-2 font-medium">Domain</th>
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium text-right">HIBP Count</th>
                      <th className="px-4 py-2 font-medium text-right">In Vault</th>
                      <th className="px-4 py-2 font-medium">Tags</th>
                      <th className="px-4 py-2 font-medium w-20" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.breaches.map(b => (
                      <tr key={b.breach_name} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <div>
                            <Link
                              href={`/breaches/${encodeURIComponent(b.breach_name)}`}
                              className="font-medium hover:text-primary transition-colors"
                            >
                              {b.title}
                            </Link>
                            <div className="text-xs text-muted-foreground font-mono mt-0.5">{b.breach_name}</div>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          {b.domain ? (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Globe className="h-3 w-3" />{b.domain}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {b.breach_date || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {b.pwn_count > 0 ? (
                            <span className="text-xs font-mono flex items-center justify-end gap-1">
                              <Users className="h-3 w-3 text-muted-foreground" />
                              {fmtCount(b.pwn_count)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {b.credential_count > 0 ? (
                            <Badge variant="secondary" className="text-xs font-mono">
                              {b.credential_count.toLocaleString()}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground/40">0</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <BreachBadges b={b} />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
                              <Link href={`/credentials?breach=${encodeURIComponent(b.breach_name)}`}>
                                <Search className="h-3 w-3 mr-1" />Search
                              </Link>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Pagination */}
                {data.pages > 1 && (
                  <div className="flex items-center justify-center gap-2 border-t px-4 py-3">
                    <Button size="sm" variant="outline" disabled={page <= 1 || loading}
                      onClick={() => load(page - 1, q)}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm">Page {page} of {data.pages}</span>
                    <Button size="sm" variant="outline" disabled={page >= data.pages || loading}
                      onClick={() => load(page + 1, q)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
