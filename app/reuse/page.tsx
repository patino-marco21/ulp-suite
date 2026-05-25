"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Loader2, RefreshCw, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { useRouter } from "next/navigation"

interface ReuseRow {
  email: string
  password: string
  domain_count: number
  domains: string[]
}

interface ReuseResult {
  success: boolean
  results: ReuseRow[]
  total: number
  page: number
  pages: number
}

const MAX_DOMAIN_BADGES = 5

export default function ReusePage() {
  useAuth(true)
  const { toast } = useToast()
  const router = useRouter()

  const [data, setData]     = useState<ReuseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage]     = useState(1)

  // Search filters
  const [emailFilter, setEmailFilter]   = useState('')
  const [pwFilter, setPwFilter]         = useState('')
  const [emailInput, setEmailInput]     = useState('')
  const [pwInput, setPwInput]           = useState('')

  const load = useCallback(async (p: number, email: string, pw: string) => {
    setLoading(true)
    try {
      const ps = new URLSearchParams({ page: String(p), limit: '50' })
      if (email) ps.set('email', email)
      if (pw)    ps.set('password', pw)
      const res  = await fetch(`/api/reuse?${ps}`)
      const json = await res.json()
      if (json.success) {
        setData(json)
        setPage(p)
      } else {
        throw new Error(json.error)
      }
    } catch {
      toast({ title: "Failed to load reuse data", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load(1, '', '') }, [load])

  const applySearch = () => {
    setEmailFilter(emailInput)
    setPwFilter(pwInput)
    load(1, emailInput, pwInput)
  }

  const clearSearch = () => {
    setEmailInput(''); setPwInput('')
    setEmailFilter(''); setPwFilter('')
    load(1, '', '')
  }

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: `${label} copied` })
  }

  const searchForEmail = (email: string) => {
    router.push(`/credentials?q=${encodeURIComponent(email)}`)
  }

  const hasSearch = !!(emailFilter || pwFilter)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Password Reuse
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Email:password pairs found on multiple domains — high-value credential stuffing targets
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load(page, emailFilter, pwFilter)} disabled={loading}>
            {loading
              ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="mr-2 h-3.5 w-3.5" />
            }
            Refresh
          </Button>
        </div>

        {/* Search row */}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[160px] space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Email filter</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applySearch()}
                placeholder="e.g. @gmail.com"
                className="pl-8 h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div className="flex-1 min-w-[160px] space-y-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Password filter</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={pwInput}
                onChange={e => setPwInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applySearch()}
                placeholder="substring match…"
                className="pl-8 h-8 text-xs font-mono"
              />
            </div>
          </div>
          <Button size="sm" className="h-8 text-xs" onClick={applySearch} disabled={loading}>
            Search
          </Button>
          {hasSearch && (
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={clearSearch}>
              <X className="mr-1 h-3 w-3" />Clear
            </Button>
          )}
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
            {/* Meta bar */}
            <div className="flex items-center justify-between border-b px-4 py-2 gap-3">
              <span className="text-sm text-muted-foreground">
                {data.total.toLocaleString()} reused pair{data.total !== 1 ? "s" : ""}
                {data.pages > 1 && ` (page ${data.page} of ${data.pages})`}
              </span>
              <div className="flex items-center gap-2">
                {hasSearch && (
                  <Badge variant="outline" className="text-xs font-mono gap-1">
                    <Search className="h-2.5 w-2.5" />
                    {[emailFilter && `email: ${emailFilter}`, pwFilter && `pw: ${pwFilter}`].filter(Boolean).join(' · ')}
                  </Badge>
                )}
                {data.total === 0 && (
                  <span className="text-xs text-green-500 font-medium">No reused credentials found</span>
                )}
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>
            </div>

            {data.results.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">
                {hasSearch
                  ? `No credential reuse found matching your filter.`
                  : 'No credential reuse detected in your dataset.'}
              </div>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background border-b">
                    <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Email</th>
                      <th className="px-4 py-2 font-medium">Password</th>
                      <th className="px-4 py-2 font-medium w-20 text-right">Domains</th>
                      <th className="px-4 py-2 font-medium">Found On</th>
                      <th className="px-4 py-2 font-medium w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.results.map((row, i) => (
                      <tr key={i} className="border-b transition-colors hover:bg-muted/30">
                        <td className="max-w-xs truncate px-4 py-2.5 font-mono text-xs">
                          {row.email}
                        </td>
                        <td className="max-w-[12rem] truncate px-4 py-2.5 font-mono text-xs">
                          {row.password}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Badge
                            variant="outline"
                            className="text-xs font-medium border-amber-500/50 text-amber-500"
                          >
                            {row.domain_count}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {row.domains.slice(0, MAX_DOMAIN_BADGES).map(d => (
                              <Badge key={d} variant="secondary" className="text-xs font-normal">
                                {d}
                              </Badge>
                            ))}
                            {row.domains.length > MAX_DOMAIN_BADGES && (
                              <Badge variant="outline" className="text-xs font-normal">
                                +{row.domains.length - MAX_DOMAIN_BADGES} more
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              title="Copy email:password"
                              onClick={() => copy(`${row.email}:${row.password}`, "email:password")}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              title="Search for this email in credentials"
                              onClick={() => searchForEmail(row.email)}
                            >
                              <Search className="h-3 w-3" />
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={data.page <= 1 || loading}
                      onClick={() => load(data.page - 1, emailFilter, pwFilter)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm">Page {data.page} of {data.pages}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={data.page >= data.pages || loading}
                      onClick={() => load(data.page + 1, emailFilter, pwFilter)}
                    >
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
