"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import { Layers, ChevronDown, ChevronRight, Copy, Loader2, RefreshCw, Search, X, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"

interface PasswordCluster {
  representative: string
  variants: string[]
  total_freq: number
}

interface SimilarResult {
  success: boolean
  clusters: PasswordCluster[]
  total_clusters: number
}

const LIMIT_OPTIONS = [50, 100, 200, 500]

export default function SimilarPage() {
  useAuth(true)
  const { toast } = useToast()

  const [data, setData]           = useState<SimilarResult | null>(null)
  const [loading, setLoading]     = useState(true)
  const [expanded, setExpanded]   = useState<Set<number>>(new Set())

  // Filter / tuning controls
  const [minFreq, setMinFreq]     = useState(2)
  const [minFreqInput, setMinFreqInput] = useState('2')
  const [limit, setLimit]         = useState(200)
  const [searchQ, setSearchQ]     = useState('')

  const load = useCallback(async (freq: number, lim: number) => {
    setLoading(true)
    setExpanded(new Set())
    try {
      const res  = await fetch(`/api/similar?min_freq=${freq}&limit=${lim}`)
      const json = await res.json()
      if (json.success) {
        setData(json)
      } else {
        throw new Error(json.error)
      }
    } catch {
      toast({ title: "Failed to load similar passwords", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load(minFreq, limit) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = () => {
    const freq = Math.max(2, parseInt(minFreqInput, 10) || 2)
    setMinFreq(freq)
    setMinFreqInput(String(freq))
    load(freq, limit)
  }

  const toggle = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: "Copied" })
  }

  const copyCluster = (cluster: PasswordCluster) => {
    navigator.clipboard.writeText(cluster.variants.join('\n'))
    toast({ title: `${cluster.variants.length} passwords copied` })
  }

  // Client-side filter by representative pattern
  const filteredClusters = (data?.clusters ?? []).filter(c =>
    !searchQ.trim() || c.representative.toLowerCase().includes(searchQ.toLowerCase()) ||
    c.variants.some(v => v.toLowerCase().includes(searchQ.toLowerCase()))
  )

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Layers className="h-5 w-5 text-violet-500" />
              Similar Passwords
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Clusters grouped by trigram similarity — useful for rule-based cracking and pattern analysis
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load(minFreq, limit)} disabled={loading}>
            {loading
              ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="mr-2 h-3.5 w-3.5" />
            }
            Refresh
          </Button>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-end gap-3">
          {/* Search within loaded clusters */}
          <div className="flex-1 min-w-[180px] relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Filter clusters…"
              className="pl-8 h-8 text-xs font-mono"
            />
            {searchQ && (
              <button
                onClick={() => setSearchQ('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <SlidersHorizontal className="h-3 w-3" /> Min frequency
              </label>
              <Input
                type="number"
                min={2}
                max={10000}
                value={minFreqInput}
                onChange={e => setMinFreqInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applyFilters()}
                className="w-24 h-8 text-xs font-mono"
                placeholder="2"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Result limit
              </label>
              <select
                value={limit}
                onChange={e => { setLimit(Number(e.target.value)); setTimeout(() => load(minFreq, Number(e.target.value)), 0) }}
                className="h-8 text-xs border border-border rounded-md bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
              >
                {LIMIT_OPTIONS.map(n => (
                  <option key={n} value={n}>{n} clusters</option>
                ))}
              </select>
            </div>

            <Button size="sm" className="h-8 text-xs" onClick={applyFilters} disabled={loading}>
              Apply
            </Button>
          </div>
        </div>
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
            <div className="flex items-center border-b px-4 py-2 gap-3">
              <span className="text-sm text-muted-foreground">
                {searchQ
                  ? `${filteredClusters.length} of ${data.clusters.length} clusters`
                  : `${data.total_clusters.toLocaleString()} cluster${data.total_clusters !== 1 ? "s" : ""} found`
                }
                {data.clusters.length < data.total_clusters && ` (showing top ${data.clusters.length})`}
              </span>
              {searchQ && (
                <Badge variant="outline" className="text-xs font-mono">
                  pattern: {searchQ}
                </Badge>
              )}
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>

            {filteredClusters.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">
                {searchQ ? `No clusters matching "${searchQ}"` : 'No similar password clusters found.'}
              </div>
            ) : (
              <div className="divide-y">
                {filteredClusters.map((cluster, i) => (
                  <div key={i} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                    {/* Cluster header */}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggle(i)}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left"
                      >
                        {expanded.has(i)
                          ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        }
                        <span className="font-mono text-sm truncate">{cluster.representative}</span>
                      </button>

                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="secondary" className="text-xs font-normal">
                          {cluster.variants.length} variants
                        </Badge>
                        <Badge variant="outline" className="text-xs font-normal text-violet-500 border-violet-500/40">
                          {cluster.total_freq.toLocaleString()} total
                        </Badge>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          title="Copy all variants"
                          onClick={() => copyCluster(cluster)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {/* Expanded variant list */}
                    {expanded.has(i) && (
                      <div className="mt-3 ml-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                        {cluster.variants.map((v, vi) => (
                          <div
                            key={vi}
                            className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5 group"
                          >
                            <span className="font-mono text-xs truncate">{v}</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity ml-1 shrink-0"
                              onClick={() => copy(v)}
                            >
                              <Copy className="h-2.5 w-2.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
