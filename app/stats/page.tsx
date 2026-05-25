"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect } from "react"
import {
  BarChart2, Database, Globe, Mail, Package, Clock, Download,
  RefreshCw, Loader2, Network, KeyRound, ShieldAlert, Building2,
  AtSign, Lock, TrendingUp, Repeat2,
  Server, FileText, ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/hooks/useAuth"
import { useToast } from "@/hooks/use-toast"
import type { StatsResult } from "@/lib/stats-cache"

type StatsData = StatsResult

function fmt(n: number): string { return n.toLocaleString() }

function pct(n: number, total: number): string {
  if (!total) return '0%'
  return `${(n / total * 100).toFixed(1)}%`
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never"
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return "Just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function BarRow({ label, count, max, colorClass = 'bg-primary' }: { label: string; count: number; max: number; colorClass?: string }) {
  const p = max > 0 ? (count / max) * 100 : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-mono truncate max-w-[60%] text-xs" title={label}>{label || '(empty)'}</span>
        <span className="text-muted-foreground tabular-nums text-xs">{fmt(count)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted">
        <div className={`h-1.5 rounded-full ${colorClass} transition-all duration-500`} style={{ width: `${p}%` }} />
      </div>
    </div>
  )
}

function DonutSlice({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2">
        <div className={`h-3 w-3 rounded-full ${color} shrink-0`} />
        <span className="text-xs text-muted-foreground">{label || '(untiered)'}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tabular-nums">{fmt(count)}</span>
        <span className="text-xs text-muted-foreground w-12 text-right">{pct(count, total)}</span>
      </div>
    </div>
  )
}

const TIER_COLORS: Record<string, string> = {
  T1: 'bg-emerald-500', T2: 'bg-blue-500', T3: 'bg-amber-500', '': 'bg-muted-foreground',
}
const LT_COLORS: Record<string, string> = {
  email: 'bg-violet-500', phone: 'bg-cyan-500', username: 'bg-orange-500', '': 'bg-muted-foreground',
}
const MASK_COLORS: Record<string, string> = {
  alphanumeric: 'bg-primary', mixed: 'bg-emerald-500', numeric: 'bg-blue-500',
  alpha: 'bg-violet-500', empty: 'bg-muted-foreground',
}
const SCHEME_COLORS: Record<string, string> = {
  https: 'bg-emerald-500', http: 'bg-red-500',
}
const ENTROPY_COLORS: Record<string, string> = {
  very_weak: 'bg-red-500', weak: 'bg-orange-500', moderate: 'bg-amber-500',
  strong: 'bg-emerald-500', long: 'bg-blue-500',
}
const ENTROPY_LABELS: Record<string, string> = {
  very_weak: 'Very Weak', weak: 'Weak', moderate: 'Moderate',
  strong: 'Strong', long: 'Long (20+)',
}
const ENTROPY_ORDER = ['very_weak', 'weak', 'moderate', 'strong', 'long']

export default function StatsPage() {
  useAuth(true)
  const { toast } = useToast()
  const [data, setData]           = useState<StatsData | null>(null)
  const [loading, setLoading]     = useState(true)
  const [downloading, setDownloading] = useState(false)

  const load = async (bust = false) => {
    setLoading(true)
    try {
      const url = bust ? `/api/stats?bust=${Date.now()}` : '/api/stats'
      const res = await fetch(url)
      const json = await res.json()
      if (json.success) setData(json)
      else throw new Error(json.error)
    } catch {
      toast({ title: "Failed to load stats", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const downloadWordlist = async () => {
    setDownloading(true)
    try {
      const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'wordlist' }) })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = 'wordlist.txt'; a.click()
      URL.revokeObjectURL(url)
    } catch { toast({ title: "Wordlist download failed", variant: "destructive" }) }
    finally { setDownloading(false) }
  }

  const exportDomain = async (domain: string, format: 'csv' | 'spray') => {
    try {
      const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, domain }) })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = format === 'spray' ? `spray-${domain}.txt` : `ulp-export-${domain}.csv`; a.click()
      URL.revokeObjectURL(url)
    } catch { toast({ title: "Export failed", variant: "destructive" }) }
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <div className="p-2 rounded-xl bg-primary/10"><BarChart2 className="h-7 w-7 text-primary" /></div>
            Statistics
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Overview of all imported credential data
            {data && <span className="ml-2 inline-flex items-center gap-1 text-xs"><Clock className="h-3 w-3" />Last import: {relativeTime(data.credentials.last_import)}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
            Refresh
          </Button>
          <Button size="sm" onClick={downloadWordlist} disabled={downloading || !data}>
            {downloading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />}
            Wordlist
          </Button>
        </div>
      </div>

      {loading && !data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="glass-card animate-pulse"><CardContent className="p-6">
              <div className="h-4 w-24 bg-muted rounded mb-3" /><div className="h-8 w-32 bg-muted rounded" />
            </CardContent></Card>
          ))}
        </div>
      )}

      {data && (
        <>
          {/* ── Row 1: Core KPI cards ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Credentials', value: fmt(data.credentials.total), icon: Database, color: 'text-blue-500', bg: 'bg-blue-500/10' },
              { label: 'Unique Domains',    value: fmt(data.credentials.unique_domains), icon: Globe, color: 'text-green-500', bg: 'bg-green-500/10' },
              { label: 'Unique Emails',     value: fmt(data.credentials.unique_emails), icon: Mail, color: 'text-purple-500', bg: 'bg-purple-500/10' },
              { label: 'Sources Uploaded',  value: fmt(data.sources.total), icon: Package, color: 'text-orange-500', bg: 'bg-orange-500/10' },
            ].map(({ label, value, icon: Icon, color, bg }) => (
              <Card key={label} className="glass-card">
                <CardContent className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`p-2 rounded-lg ${bg}`}><Icon className={`h-4 w-4 ${color}`} /></div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
                  </div>
                  <p className="text-2xl font-bold tabular-nums">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ── Row 2: Insight KPI cards ──────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="glass-card">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-amber-500/10"><Repeat2 className="h-4 w-4 text-amber-500" /></div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Password Reuse</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">{data.reuse_stats.reuse_pct}%</p>
                <p className="text-xs text-muted-foreground mt-1">{fmt(data.reuse_stats.reused_pairs)} pairs on 2+ domains</p>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-cyan-500/10"><Building2 className="h-4 w-4 text-cyan-500" /></div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Corporate Emails</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">{pct(data.corporate_stats.corporate, data.corporate_stats.total_emails)}</p>
                <p className="text-xs text-muted-foreground mt-1">{fmt(data.corporate_stats.corporate)} of {fmt(data.corporate_stats.total_emails)} emails</p>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10"><Lock className="h-4 w-4 text-emerald-500" /></div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">HTTPS Coverage</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">
                  {pct(data.url_scheme_dist.find(s => s.scheme === 'https')?.count || 0,
                       data.url_scheme_dist.reduce((s, r) => s + r.count, 0))}
                </p>
                <p className="text-xs text-muted-foreground mt-1">of URLs with known scheme</p>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-red-500/10"><ShieldAlert className="h-4 w-4 text-red-500" /></div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Breach Sources</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">{fmt(data.top_breaches.length)}+</p>
                <p className="text-xs text-muted-foreground mt-1">named breach datasets</p>
              </CardContent>
            </Card>
          </div>

          {/* ── Row 3: Distribution donuts ────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Country tier distribution */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" />Country Tiers</CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const total = data.country_tier_dist.reduce((s, r) => s + r.count, 0)
                  return data.country_tier_dist.map(r => (
                    <DonutSlice key={r.tier} label={r.tier || 'Untiered'} count={r.count} total={total} color={TIER_COLORS[r.tier] || 'bg-muted-foreground'} />
                  ))
                })()}
              </CardContent>
            </Card>

            {/* Login type distribution */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><AtSign className="h-4 w-4 text-muted-foreground" />Login Types</CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const total = data.login_type_dist.reduce((s, r) => s + r.count, 0)
                  const icons: Record<string, string> = { email: '@ ', phone: '📞 ', username: '👤 ', '': '⬜ ' }
                  return data.login_type_dist.map(r => (
                    <DonutSlice key={r.type} label={icons[r.type] + (r.type || 'empty')} count={r.count} total={total} color={LT_COLORS[r.type] || 'bg-muted-foreground'} />
                  ))
                })()}
              </CardContent>
            </Card>

            {/* Password pattern distribution */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4 text-muted-foreground" />Password Patterns</CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const total = data.password_patterns.reduce((s, r) => s + r.count, 0)
                  return data.password_patterns.map(r => (
                    <DonutSlice key={r.mask} label={r.mask || 'empty'} count={r.count} total={total} color={MASK_COLORS[r.mask] || 'bg-muted-foreground'} />
                  ))
                })()}
              </CardContent>
            </Card>

            {/* URL scheme distribution */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4 text-muted-foreground" />URL Schemes</CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  const total = data.url_scheme_dist.reduce((s, r) => s + r.count, 0)
                  return data.url_scheme_dist.map(r => (
                    <DonutSlice key={r.scheme} label={r.scheme} count={r.count} total={total} color={SCHEME_COLORS[r.scheme] || 'bg-muted-foreground'} />
                  ))
                })()}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 4: Password strength + Import timeline ───────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Password entropy / strength distribution */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-muted-foreground" />Password Strength</CardTitle>
              </CardHeader>
              <CardContent>
                {data.entropy_band_dist.length === 0
                  ? <p className="text-sm text-muted-foreground">No data yet</p>
                  : (() => {
                      const total = data.entropy_band_dist.reduce((s, r) => s + r.count, 0)
                      const sorted = [...data.entropy_band_dist].sort(
                        (a, b) => ENTROPY_ORDER.indexOf(a.band) - ENTROPY_ORDER.indexOf(b.band)
                      )
                      return sorted.map(r => (
                        <DonutSlice key={r.band}
                          label={ENTROPY_LABELS[r.band] || r.band}
                          count={r.count} total={total}
                          color={ENTROPY_COLORS[r.band] || 'bg-muted-foreground'} />
                      ))
                    })()}
              </CardContent>
            </Card>

            {/* Import timeline — daily bar sparkline */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-muted-foreground" />Import Activity (90 days)</CardTitle>
              </CardHeader>
              <CardContent>
                {data.import_timeline.length === 0
                  ? <p className="text-sm text-muted-foreground">No activity in the last 90 days</p>
                  : (() => {
                      const maxC = Math.max(...data.import_timeline.map(d => d.count), 1)
                      const total90 = data.import_timeline.reduce((s, d) => s + d.count, 0)
                      return (
                        <>
                          <div className="flex items-end gap-px h-20 w-full mb-2">
                            {data.import_timeline.map(({ day, count }) => (
                              <div key={day}
                                title={`${day}: ${fmt(count)} records`}
                                className="flex-1 bg-primary/70 hover:bg-primary rounded-sm transition-colors cursor-default"
                                style={{ height: `${Math.max((count / maxC) * 100, 3)}%` }} />
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">{fmt(total90)} credentials imported in the last 90 days</p>
                        </>
                      )
                    })()}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 5: Top domains + Top passwords (expanded to 50) ──────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" />Top Domains</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_domains.map(({ domain, count }) => (
                  <div key={domain} className="group">
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-mono truncate max-w-[50%] text-xs" title={domain}>{domain}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground tabular-nums text-xs mr-1">{fmt(count)}</span>
                        <Button size="icon" variant="ghost" className="h-5 w-5 opacity-0 group-hover:opacity-100" title={`CSV for ${domain}`} onClick={() => exportDomain(domain, 'csv')}><Download className="h-3 w-3" /></Button>
                        <Button size="icon" variant="ghost" className="h-5 w-5 opacity-0 group-hover:opacity-100" title={`Spray list for ${domain}`} onClick={() => exportDomain(domain, 'spray')}><Network className="h-3 w-3" /></Button>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted">
                      <div className="h-1.5 rounded-full bg-primary transition-all duration-500" style={{ width: `${data.top_domains[0].count > 0 ? (count / data.top_domains[0].count) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="glass-card">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4 text-muted-foreground" />Top 50 Passwords</CardTitle>
                  <Button variant="ghost" size="sm" className="text-xs h-7" onClick={downloadWordlist} disabled={downloading}>
                    {downloading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />}Full wordlist
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 max-h-96 overflow-auto">
                {data.top_passwords.map(({ password, count }, idx) => (
                  <div key={password} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground/60 tabular-nums w-6">{idx + 1}.</span>
                    <BarRow label={password} count={count} max={data.top_passwords[0].count} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 6: Password length + email domains ────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><BarChart2 className="h-4 w-4 text-muted-foreground" />Password Length Distribution</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const maxCount = Math.max(...data.password_lengths.map(b => b.count))
                  return data.password_lengths.map(({ bucket, count }) => (
                    <div key={bucket} className="flex items-center gap-2">
                      <span className="font-mono text-xs w-16 text-muted-foreground shrink-0">{bucket} chars</span>
                      <div className="flex-1">
                        <div className="h-1.5 rounded-full bg-muted">
                          <div className="h-1.5 rounded-full bg-blue-500 transition-all duration-500" style={{ width: `${maxCount > 0 ? (count / maxCount) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <span className="text-muted-foreground tabular-nums text-xs w-20 text-right">{fmt(count)}</span>
                    </div>
                  ))
                })()}
              </CardContent>
            </Card>

            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><AtSign className="h-4 w-4 text-muted-foreground" />Top Email Providers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_email_domains.length === 0
                  ? <p className="text-sm text-muted-foreground">No data yet</p>
                  : data.top_email_domains.map(({ domain, count }) => (
                    <BarRow key={domain} label={domain} count={count} max={data.top_email_domains[0].count} colorClass="bg-violet-500" />
                  ))}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 7: Top breaches + Top TLDs + Top URL Hosts ───────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {data.top_breaches.length > 0 && (
              <Card className="glass-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-muted-foreground" />Breach Leaderboard</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {data.top_breaches.map(({ breach_name, count }, idx) => (
                    <div key={breach_name} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground/60 tabular-nums w-6">{idx + 1}.</span>
                      <BarRow label={breach_name} count={count} max={data.top_breaches[0].count} colorClass="bg-red-500" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Globe className="h-4 w-4 text-muted-foreground" />Top TLDs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_tlds.map(({ tld, count }) => (
                  <BarRow key={tld} label={`.${tld}`} count={count} max={data.top_tlds[0].count} />
                ))}
              </CardContent>
            </Card>

            {/* Top URL hosts */}
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Server className="h-4 w-4 text-muted-foreground" />Top URL Hosts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_url_hosts.length === 0
                  ? <p className="text-sm text-muted-foreground">No data yet</p>
                  : data.top_url_hosts.map(({ host, count }) => (
                    <BarRow key={host} label={host} count={count} max={data.top_url_hosts[0].count} colorClass="bg-cyan-500" />
                  ))}
              </CardContent>
            </Card>
          </div>

          {/* ── Sources info + Top sources ─────────────────────────────────────── */}
          {data.sources.total > 0 && (
            <Card className="glass-card">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{fmt(data.sources.total)}</span> source file{data.sources.total !== 1 ? "s" : ""} imported
                  {data.sources.total_lines > 0 && (
                    <> — <span className="font-medium text-foreground">{fmt(data.sources.total_lines)}</span> total lines processed</>
                  )}
                </p>
              </CardContent>
            </Card>
          )}

          {data.top_sources.length > 0 && (
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" />Top Source Files</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.top_sources.map(({ source_file, count }, idx) => (
                  <div key={source_file} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground/60 tabular-nums w-6 shrink-0">{idx + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <BarRow label={source_file || '(unnamed)'} count={count} max={data.top_sources[0].count} colorClass="bg-orange-500" />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
