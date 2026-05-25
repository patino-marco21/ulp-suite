"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
import {
  ShieldAlert, ArrowLeft, BadgeCheck, Users, Globe, Database,
  Mail, Calendar, Loader2, RefreshCw, Download, Copy, ExternalLink, Tag
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { useAuth, isAdmin } from "@/hooks/useAuth"
import Link from "next/link"

interface BreachRecord {
  breach_name: string
  title: string
  domain: string
  breach_date: string
  pwn_count: number
  description: string
  data_classes: string[]
  is_verified: boolean
  is_fabricated: boolean
  is_sensitive: boolean
  is_mega_dump: boolean
  is_stealer_log: boolean
  is_malware: boolean
  is_spam_list: boolean
}

interface BreachStats {
  credential_count: number
  unique_emails: number
  unique_domains: number
  source_files: string[]
}

function fmtCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export default function BreachDetailPage() {
  const { user } = useAuth(true)
  const { toast } = useToast()
  const params = useParams()
  const router = useRouter()
  const breachName = decodeURIComponent(params.name as string)

  const [breach, setBreach] = useState<BreachRecord | null>(null)
  const [stats, setStats] = useState<BreachStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [retagFile, setRetagFile] = useState('')
  const [retagging, setRetagging] = useState(false)
  const [exporting, setExporting] = useState(false)

  const userIsAdmin = user ? isAdmin(user) : false

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/breaches/${encodeURIComponent(breachName)}`)
      const json = await res.json()
      if (json.success) {
        setBreach(json.breach)
        setStats(json.stats)
      } else {
        toast({ title: json.error || "Breach not found", variant: "destructive" })
        router.push('/breaches')
      }
    } catch {
      toast({ title: "Failed to load breach", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [breachName, router, toast])

  useEffect(() => { load() }, [load])

  const exportBreachCredentials = async (format: 'csv' | 'userpass' | 'ulp') => {
    setExporting(true)
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, query: '', domain: '', breach_name: breachName }),
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `breach-${breachName}.${format === 'csv' ? 'csv' : 'txt'}`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast({ title: "Export failed", variant: "destructive" })
    } finally {
      setExporting(false)
    }
  }

  const retagSourceFile = async () => {
    if (!retagFile.trim()) return
    setRetagging(true)
    try {
      const res = await fetch(`/api/breaches/${encodeURIComponent(breachName)}/retag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_files: [retagFile.trim()] }),
      })
      const json = await res.json()
      if (json.success) {
        toast({ title: `Re-tag mutation fired for "${retagFile.trim()}" — runs in background` })
        setRetagFile('')
        load()
      } else {
        toast({ title: json.error || 'Re-tag failed', variant: "destructive" })
      }
    } catch {
      toast({ title: "Re-tag failed", variant: "destructive" })
    } finally {
      setRetagging(false)
    }
  }

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: `${label} copied` })
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!breach) return null

  const statCards = [
    { label: "In Vault", value: fmtCount(stats?.credential_count ?? 0), icon: Database, color: "text-blue-500", bg: "bg-blue-500/10" },
    { label: "Unique Emails", value: fmtCount(stats?.unique_emails ?? 0), icon: Mail, color: "text-purple-500", bg: "bg-purple-500/10" },
    { label: "Unique Domains", value: fmtCount(stats?.unique_domains ?? 0), icon: Globe, color: "text-green-500", bg: "bg-green-500/10" },
    { label: "HIBP Count", value: breach.pwn_count > 0 ? fmtCount(breach.pwn_count) : "—", icon: Users, color: "text-orange-500", bg: "bg-orange-500/10" },
  ]

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* Back + header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground" onClick={() => router.push('/breaches')}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Back to breaches
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-3">
              <div className="p-2 rounded-xl bg-red-500/10">
                <ShieldAlert className="h-6 w-6 text-red-500" />
              </div>
              {breach.title}
            </h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <code className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{breach.breach_name}</code>
              {breach.domain && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Globe className="h-3 w-3" />{breach.domain}
                </span>
              )}
              {breach.breach_date && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" />{breach.breach_date}
                </span>
              )}
              {breach.is_verified && (
                <Badge variant="outline" className="text-xs border-green-500/40 text-green-500">
                  <BadgeCheck className="h-3 w-3 mr-1" />Verified
                </Badge>
              )}
              {breach.is_mega_dump && (
                <Badge variant="outline" className="text-xs border-purple-500/40 text-purple-500">Mega-dump</Badge>
              )}
              {breach.is_stealer_log && (
                <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-500">Stealer log</Badge>
              )}
            </div>
          </div>

          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" asChild>
              <Link href={`/credentials?breach=${encodeURIComponent(breach.breach_name)}`}>
                <ExternalLink className="mr-2 h-3.5 w-3.5" />Search credentials
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label} className="glass-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-3 mb-2">
                <div className={`p-2 rounded-lg ${bg}`}>
                  <Icon className={`h-4 w-4 ${color}`} />
                </div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
              </div>
              <p className="text-2xl font-bold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Description + data classes */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Breach Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {breach.description && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 font-medium">Description</p>
                <p
                  className="text-sm leading-relaxed text-muted-foreground"
                  dangerouslySetInnerHTML={{ __html: breach.description }}
                />
              </div>
            )}
            {breach.data_classes.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium">Exposed Data Classes</p>
                <div className="flex flex-wrap gap-1.5">
                  {breach.data_classes.map(dc => (
                    <Badge key={dc} variant="secondary" className="text-xs font-normal">{dc}</Badge>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 pt-1">
              {[
                { label: "Verified", value: breach.is_verified },
                { label: "Fabricated", value: breach.is_fabricated },
                { label: "Sensitive", value: breach.is_sensitive },
                { label: "Spam list", value: breach.is_spam_list },
                { label: "Malware", value: breach.is_malware },
                { label: "Stealer log", value: breach.is_stealer_log },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={value ? 'text-primary font-medium' : 'text-muted-foreground/40'}>
                    {value ? 'Yes' : 'No'}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Source files */}
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Source Files ({stats?.source_files.length ?? 0})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {stats?.source_files.length === 0 && (
              <p className="text-sm text-muted-foreground">No credentials from this breach in vault yet.</p>
            )}
            <div className="space-y-1 max-h-48 overflow-auto">
              {stats?.source_files.map(sf => (
                <div key={sf} className="flex items-center justify-between group rounded px-2 py-1 hover:bg-muted/40">
                  <code className="text-xs truncate flex-1">{sf}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 ml-1"
                    onClick={() => copy(sf, 'Filename')}
                  >
                    <Copy className="h-2.5 w-2.5" />
                  </Button>
                </div>
              ))}
            </div>

            {/* Re-tag a source file */}
            {userIsAdmin && (
              <div className="pt-3 border-t space-y-2">
                <p className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                  <Tag className="h-3 w-3" />Re-tag source file as this breach
                </p>
                <div className="flex gap-2">
                  <input
                    value={retagFile}
                    onChange={e => setRetagFile(e.target.value)}
                    placeholder="filename.txt"
                    className="flex-1 text-xs h-8 px-2 rounded-md border bg-background font-mono"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={retagSourceFile}
                    disabled={retagging || !retagFile.trim()}
                  >
                    {retagging ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Apply'}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground/60">
                  Fires an async ClickHouse mutation — updates run in the background.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Export */}
      {stats && stats.credential_count > 0 && (
        <Card className="glass-card">
          <CardContent className="p-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Export <strong className="text-foreground">{stats.credential_count.toLocaleString()}</strong> credentials from this breach
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => exportBreachCredentials('csv')} disabled={exporting}>
                <Download className="mr-1 h-3 w-3" />CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => exportBreachCredentials('userpass')} disabled={exporting}>
                <Download className="mr-1 h-3 w-3" />user:pass
              </Button>
              <Button size="sm" variant="outline" onClick={() => exportBreachCredentials('ulp')} disabled={exporting}>
                <Download className="mr-1 h-3 w-3" />ULP
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href={`/credentials?breach=${encodeURIComponent(breach.breach_name)}`}>
                  <ExternalLink className="mr-1 h-3 w-3" />Search
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
