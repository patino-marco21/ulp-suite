"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback } from "react"
import {
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Loader2,
  Copy, Filter, X, Globe, Download, ArrowUpDown,
  ExternalLink, FileText, Shield, Clock, Building2,
  Mail, Lock, AtSign, CheckCheck, SlidersHorizontal,
  Link2, KeyRound, Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet, SheetContent, SheetClose, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/hooks/use-toast"
import { useAuth } from "@/hooks/useAuth"
import { TIER_LABELS, VALID_TIERS } from "@/lib/country-tiers"
import { LOGIN_TYPE_SHORT } from "@/lib/login-type"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Credential {
  url: string
  email: string
  password: string
  domain: string
  source_file: string
  breach_name: string
  country_tier: string
  login_type: string
  password_length: number
  password_mask: string
  url_scheme: string
  is_corporate_email: number
  email_domain: string
  url_host: string
  password_entropy_band: string
  imported_at: string
}

interface RelatedData {
  by_email:    Credential[]
  by_domain:   Credential[]
  by_password: Credential[]
}

interface ApiResult {
  success:     boolean
  results:     Credential[]
  total:       number
  next_cursor: string | null
  query_ms?:   number
  timed_out?:  boolean   // true when query_ms > 200s — results may be incomplete
  sort?:       string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MASK_COLORS: Record<string, string> = {
  alpha:        'bg-violet-500/10 text-violet-600 border-violet-500/20',
  numeric:      'bg-blue-500/10 text-blue-600 border-blue-500/20',
  alphanumeric: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  mixed:        'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  empty:        'bg-muted/50 text-muted-foreground border-border',
}

const ENTROPY_COLORS: Record<string, string> = {
  very_low:  'text-red-500',
  low:       'text-orange-500',
  medium:    'text-yellow-500',
  high:      'text-emerald-500',
  very_high: 'text-cyan-500',
}

const MASK_OPTIONS      = ['alpha', 'numeric', 'alphanumeric', 'mixed', 'empty']
const LOGIN_TYPE_OPTIONS = ['email', 'phone', 'username', '']

const SORT_OPTIONS = [
  { value: 'imported_desc', label: 'Newest first' },
  { value: 'imported_asc',  label: 'Oldest first' },
  { value: 'domain_asc',    label: 'Domain A→Z' },
  { value: 'domain_desc',   label: 'Domain Z→A' },
  { value: 'email_asc',     label: 'Email A→Z' },
  { value: 'email_desc',    label: 'Email Z→A' },
  { value: 'pw_len_desc',   label: 'Longest password' },
  { value: 'pw_len_asc',    label: 'Shortest password' },
]

const EXPORT_FORMATS = [
  { value: 'csv',      label: 'CSV (full)' },
  { value: 'ulp',      label: 'ULP (url:email:pass)' },
  { value: 'userpass', label: 'user:pass' },
  { value: 'emails',   label: 'Emails only' },
  { value: 'domains',  label: 'Domains only' },
  { value: 'json',     label: 'JSON' },
  { value: 'ndjson',   label: 'NDJSON' },
  { value: 'hcmask',  label: 'Hashcat masks (.hcmask)' },
]

const PAGE_SIZES = [25, 50, 100, 200]

// ─── CopyButton ───────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={onClick}
      title={label ? `Copy ${label}` : 'Copy'}
      className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      {copied
        ? <CheckCheck className="h-3.5 w-3.5 text-emerald-500" />
        : <Copy className="h-3.5 w-3.5" />
      }
    </button>
  )
}

// ─── RelatedBucket ────────────────────────────────────────────────────────────

function RelatedBucket({
  title,
  Icon,
  items,
  loading,
}: {
  title: string
  Icon: React.ElementType
  items: Credential[]
  loading: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 3
  const visible = expanded ? items : items.slice(0, LIMIT)

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Loading…</span>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 py-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
        <span className="text-xs text-muted-foreground/40">{title} — none found</span>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <Badge variant="outline" className="text-[10px] h-4 px-1 ml-1">{items.length}</Badge>
      </div>
      <div className="space-y-1">
        {visible.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 group"
          >
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-mono truncate">{item.email}</p>
              <p className="text-[10px] font-mono text-muted-foreground truncate">
                {item.domain || item.email_domain || '—'}
              </p>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(`${item.email}:${item.password}`)}
              className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
              title="Copy email:password"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      {items.length > LIMIT && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          {expanded ? 'Show less ↑' : `Show ${items.length - LIMIT} more ↓`}
        </button>
      )}
    </div>
  )
}

// ─── CredentialDetailSheet ────────────────────────────────────────────────────

function CredentialDetailSheet({
  cred,
  open,
  onClose,
  onSearchEmail,
  onSearchDomain,
}: {
  cred: Credential | null
  open: boolean
  onClose: () => void
  onSearchEmail: (email: string) => void
  onSearchDomain: (domain: string) => void
}) {
  const [related, setRelated]             = useState<RelatedData | null>(null)
  const [relatedLoading, setRelatedLoading] = useState(false)

  // Fetch related credentials whenever the sheet opens on a new credential
  useEffect(() => {
    if (!open || !cred) {
      setRelated(null)
      return
    }
    let cancelled = false
    setRelatedLoading(true)
    setRelated(null)
    const params = new URLSearchParams()
    if (cred.email)  params.set('email', cred.email)
    if (cred.password) params.set('password', cred.password)
    if (cred.domain) params.set('domain', cred.domain)
    fetch(`/api/related?${params}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.success) {
          setRelated({
            by_email:    data.by_email    ?? [],
            by_domain:   data.by_domain   ?? [],
            by_password: data.by_password ?? [],
          })
        }
      })
      .catch(() => { /* silently ignore */ })
      .finally(() => { if (!cancelled) setRelatedLoading(false) })
    return () => { cancelled = true }
  }, [open, cred])

  const tierBadgeClass = (t: string) =>
    t === 'T1' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' :
    t === 'T2' ? 'bg-blue-500/10 text-blue-600 border-blue-500/20' :
    t === 'T3' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' : 'bg-muted/50 text-muted-foreground border-border'

  if (!cred) return null

  const ulpLine = cred.url
    ? `${cred.url}:${cred.email}:${cred.password}`
    : `${cred.email}:${cred.password}`

  const hasUrl = !!cred.url

  const openUrl = () => {
    const target = cred.url.startsWith('http') ? cred.url : `https://${cred.url}`
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  const hasRelated = related && (
    related.by_email.length > 0 ||
    related.by_domain.length > 0 ||
    related.by_password.length > 0
  )

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg flex flex-col gap-0 p-0 overflow-y-auto"
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <SheetHeader className="px-5 pt-5 pb-4 border-b space-y-1">
          <div className="flex items-start justify-between gap-2">
            <SheetTitle className="font-mono text-base truncate">
              {cred.domain || cred.email_domain || '(no domain)'}
            </SheetTitle>
            <SheetClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 shrink-0 mt-0.5">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </SheetClose>
          </div>
          <SheetDescription className="font-mono text-xs truncate text-muted-foreground">
            {cred.url || '(no URL)'}
          </SheetDescription>

          {/* Primary actions */}
          <div className="flex gap-2 pt-2">
            {hasUrl && (
              <Button size="sm" variant="default" className="h-8 text-xs gap-1.5 flex-1" onClick={openUrl}>
                <ExternalLink className="h-3.5 w-3.5" />
                Open URL
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 flex-1"
              onClick={() => navigator.clipboard.writeText(ulpLine)}>
              <Copy className="h-3.5 w-3.5" />
              Copy ULP
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 flex-1"
              onClick={() => navigator.clipboard.writeText(`${cred.email}:${cred.password}`)}>
              <Copy className="h-3.5 w-3.5" />
              email:pass
            </Button>
          </div>

          {/* Search quick-action buttons */}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs gap-1 flex-1 text-muted-foreground hover:text-foreground border border-border/60"
              onClick={() => { onSearchEmail(cred.email); onClose() }}
              title={`Filter for all credentials matching ${cred.email}`}
            >
              <Mail className="h-3 w-3" />
              Search this email
            </Button>
            {(cred.domain || cred.email_domain) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1 flex-1 text-muted-foreground hover:text-foreground border border-border/60"
                onClick={() => { onSearchDomain(cred.domain || cred.email_domain); onClose() }}
                title={`Filter for all credentials on ${cred.domain || cred.email_domain}`}
              >
                <Globe className="h-3 w-3" />
                Search this domain
              </Button>
            )}
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-5 py-5">

          {/* ── Full ULP line ──────────────────────────────────────────────── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Full ULP Line
            </p>
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
              <code className="flex-1 text-xs font-mono break-all leading-relaxed text-foreground">
                {ulpLine}
              </code>
              <CopyButton text={ulpLine} label="ULP line" />
            </div>
          </div>

          <Separator />

          {/* ── Individual fields ──────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Credential Fields
            </p>

            {cred.url && (
              <div className="flex items-start gap-3">
                <Globe className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">URL</p>
                  <p className="text-xs font-mono break-all">{cred.url}</p>
                </div>
                <CopyButton text={cred.url} label="URL" />
              </div>
            )}

            <div className="flex items-start gap-3">
              <Mail className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">Email / Login</p>
                <p className="text-xs font-mono break-all">{cred.email}</p>
              </div>
              <CopyButton text={cred.email} label="email" />
            </div>

            <div className="flex items-start gap-3">
              <Lock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">Password</p>
                <p className="text-xs font-mono break-all font-semibold">{cred.password}</p>
              </div>
              <CopyButton text={cred.password} label="password" />
            </div>
          </div>

          <Separator />

          {/* ── Source & breach ────────────────────────────────────────────── */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Source
            </p>

            <div className="flex items-start gap-3">
              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">Source File</p>
                <p className="text-xs font-mono break-all">
                  {cred.source_file || <span className="text-muted-foreground/50">—</span>}
                </p>
              </div>
              {cred.source_file && <CopyButton text={cred.source_file} label="source file" />}
            </div>

            {cred.breach_name && (
              <div className="flex items-start gap-3">
                <Shield className="h-4 w-4 text-rose-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">Breach</p>
                  <p className="text-xs font-mono break-all text-rose-600">{cred.breach_name}</p>
                </div>
                <CopyButton text={cred.breach_name} label="breach name" />
              </div>
            )}

            {cred.imported_at && (
              <div className="flex items-start gap-3">
                <Clock className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">Imported</p>
                  <p className="text-xs font-mono">{cred.imported_at}</p>
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* ── Metadata grid ──────────────────────────────────────────────── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Metadata
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">

              <div>
                <p className="text-xs text-muted-foreground">Login Type</p>
                <p className="text-xs font-mono capitalize mt-0.5">
                  {cred.login_type || <span className="text-muted-foreground/40">—</span>}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Country Tier</p>
                <div className="mt-0.5">
                  {cred.country_tier ? (
                    <span className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded border ${tierBadgeClass(cred.country_tier)}`}>
                      {cred.country_tier} — {TIER_LABELS[cred.country_tier] ?? ''}
                    </span>
                  ) : <span className="text-xs text-muted-foreground/40">—</span>}
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Password Mask</p>
                <div className="mt-0.5">
                  {cred.password_mask ? (
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${MASK_COLORS[cred.password_mask] || ''}`}>
                      {cred.password_mask}
                    </span>
                  ) : <span className="text-xs text-muted-foreground/40">—</span>}
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Password Length</p>
                <p className="text-xs font-mono mt-0.5">{cred.password_length} chars</p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Entropy</p>
                <p className={`text-xs font-mono capitalize mt-0.5 ${ENTROPY_COLORS[cred.password_entropy_band] || 'text-muted-foreground/40'}`}>
                  {cred.password_entropy_band?.replace('_', ' ') || '—'}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">URL Scheme</p>
                <p className="text-xs font-mono mt-0.5">
                  {cred.url_scheme || <span className="text-muted-foreground/40">—</span>}
                </p>
              </div>

              {cred.email_domain && (
                <div>
                  <p className="text-xs text-muted-foreground">Email Domain</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <AtSign className="h-3 w-3 text-muted-foreground" />
                    <p className="text-xs font-mono">{cred.email_domain}</p>
                  </div>
                </div>
              )}

              {cred.url_host && (
                <div>
                  <p className="text-xs text-muted-foreground">URL Host</p>
                  <p className="text-xs font-mono mt-0.5">{cred.url_host}</p>
                </div>
              )}

              <div>
                <p className="text-xs text-muted-foreground">Corporate Email</p>
                <div className="flex items-center gap-1 mt-0.5">
                  <Building2 className="h-3 w-3 text-muted-foreground" />
                  <p className="text-xs font-mono">
                    {cred.is_corporate_email === 1
                      ? <span className="text-orange-500 font-semibold">Yes</span>
                      : 'No'}
                  </p>
                </div>
              </div>

            </div>
          </div>

          {/* ── Related credentials ────────────────────────────────────────── */}
          <Separator />

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Related Credentials
            </p>

            {relatedLoading ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Searching related records…</span>
              </div>
            ) : related ? (
              <div className="space-y-4">
                <RelatedBucket
                  title="Same login, other domains"
                  Icon={Link2}
                  items={related.by_email}
                  loading={false}
                />
                <RelatedBucket
                  title="Other accounts on this domain"
                  Icon={Users}
                  items={related.by_domain}
                  loading={false}
                />
                <RelatedBucket
                  title="Same password reused elsewhere"
                  Icon={KeyRound}
                  items={related.by_password}
                  loading={false}
                />
                {!hasRelated && (
                  <p className="text-xs text-muted-foreground/50 py-1">
                    No related credentials found.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/40 py-1">
                Open a credential to load related records.
              </p>
            )}
          </div>

        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CredentialsPage() {
  useAuth(true)

  const [data, setData]               = useState<ApiResult | null>(null)
  const [loading, setLoading]         = useState(true)
  const [exportLoading, setExportLoading] = useState(false)
  const [cursorStack, setCursorStack]     = useState<Array<string | null>>([])
  const [currentCursor, setCurrentCursor] = useState<string | null>(null)
  const resetCursor = () => { setCursorStack([]); setCurrentCursor(null) }

  // Credential detail sheet
  const [selectedCred, setSelectedCred] = useState<Credential | null>(null)
  const [sheetOpen, setSheetOpen]       = useState(false)

  // Basic filters
  const [q, setQ]                     = useState('')
  const [domain, setDomain]           = useState('')
  const [breach, setBreach]           = useState('')
  const [loginType, setLoginType]     = useState('')
  const [pwMask, setPwMask]           = useState<string[]>([])
  const [isCorporate, setIsCorporate] = useState(false)
  const [urlScheme, setUrlScheme]     = useState('')
  const [tierInclude, setTierInclude] = useState<string[]>([])
  const [tierExclude, setTierExclude] = useState<string[]>([])
  const [tierOpen, setTierOpen]       = useState(false)

  // Advanced filters (hidden behind toggle)
  const [advOpen, setAdvOpen]               = useState(false)
  const [dateFrom, setDateFrom]             = useState('')
  const [dateTo, setDateTo]                 = useState('')
  const [pwLenMin, setPwLenMin]             = useState('')
  const [pwLenMax, setPwLenMax]             = useState('')
  const [emailDomainFilter, setEmailDomainFilter] = useState('')
  const [sourceFileFilter, setSourceFileFilter]   = useState('')
  const [urlHostFilter, setUrlHostFilter]         = useState('')
  const [regexMode, setRegexMode]           = useState(false)

  // Sort / page size / export format
  const [sortKey, setSortKey]         = useState('imported_desc')
  const [limit, setLimit]             = useState(50)
  const [exportFmt, setExportFmt]     = useState('csv')

  const { toast } = useToast()

  const buildParams = useCallback((cursor: string | null, overrides?: { sort?: string; limit?: number; q?: string; domain?: string }) => {
    const effectiveSort  = overrides?.sort   ?? sortKey
    const effectiveLimit = overrides?.limit  ?? limit
    const effectiveQ     = overrides?.q      ?? q
    const effectiveDomain = overrides?.domain ?? domain
    const ps = new URLSearchParams({ limit: String(effectiveLimit), sort: effectiveSort })
    if (cursor) ps.set('cursor', cursor)
    if (effectiveQ.trim())     ps.set('q', effectiveQ.trim())
    if (effectiveDomain)       ps.set('domain', effectiveDomain)
    if (breach)             ps.set('breach', breach)
    if (loginType)          ps.set('login_type', loginType)
    if (pwMask.length)      ps.set('pw_mask', pwMask.join(','))
    if (isCorporate)          ps.set('is_corporate', '1')
    if (urlScheme)            ps.set('url_scheme', urlScheme)
    if (tierInclude.length)   ps.set('tier_include', tierInclude.join(','))
    if (tierExclude.length)   ps.set('tier_exclude', tierExclude.join(','))
    // Advanced
    if (dateFrom)           ps.set('date_from', dateFrom)
    if (dateTo)             ps.set('date_to', dateTo)
    if (pwLenMin)           ps.set('pw_len_min', pwLenMin)
    if (pwLenMax)           ps.set('pw_len_max', pwLenMax)
    if (emailDomainFilter)  ps.set('email_domain', emailDomainFilter)
    if (sourceFileFilter)   ps.set('source_file', sourceFileFilter)
    if (urlHostFilter)      ps.set('url_host', urlHostFilter)
    if (regexMode)          ps.set('regex', '1')
    return ps
  }, [
    q, domain, breach, loginType, pwMask, isCorporate, urlScheme, tierInclude, tierExclude,
    dateFrom, dateTo, pwLenMin, pwLenMax, emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode,
    sortKey, limit,
  ])

  const load = useCallback(async (cursor: string | null, overrides?: { sort?: string; limit?: number; q?: string; domain?: string }) => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/credentials?${buildParams(cursor, overrides)}`)
      const json = await res.json()
      if (json.success) {
        setData(json)
        setCurrentCursor(cursor)
      } else if (json.timed_out) {
        // 408 timeout: show the structured timeout response in the results panel
        // instead of a toast — the user can see why and what to do.
        setData({ ...json, results: [] })
        setCurrentCursor(cursor)
      } else {
        toast({ title: 'Failed to load', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to load', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [buildParams, toast])

  useEffect(() => { load(null) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = () => { resetCursor(); load(null) }

  const clearAll = () => {
    setQ(''); setDomain(''); setBreach(''); setLoginType(''); setPwMask([])
    setIsCorporate(false); setUrlScheme(''); setTierInclude([]); setTierExclude([])
    setDateFrom(''); setDateTo(''); setPwLenMin(''); setPwLenMax('')
    setEmailDomainFilter(''); setSourceFileFilter(''); setUrlHostFilter('')
    setRegexMode(false)
    setSortKey('imported_desc'); setLimit(50)
    // Fetch directly with hardcoded defaults — all state setters above are async,
    // so calling load() here would still see the old values via its closure.
    setLoading(true)
    setCursorStack([]); setCurrentCursor(null)
    fetch('/api/credentials?limit=50&sort=imported_desc')
      .then(r => r.json())
      .then(json => { if (json.success) { setData(json); setCurrentCursor(null) } })
      .catch(() => { toast({ title: 'Failed to load', variant: 'destructive' }) })
      .finally(() => setLoading(false))
  }

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: 'Copied' })
  }

  const openDetail = (cred: Credential) => {
    setSelectedCred(cred)
    setSheetOpen(true)
  }

  // Quick-action callbacks from the detail sheet
  const handleSearchEmail = (email: string) => {
    setQ(email)
    resetCursor(); load(null, { q: email })
  }
  const handleSearchDomain = (dom: string) => {
    setDomain(dom)
    resetCursor(); load(null, { domain: dom })
  }

  /** Cycle sort: unsorted → asc → desc → reset; updates the dropdown in sync. */
  const cycleSortKey = (ascKey: string, descKey: string) => {
    const next = sortKey === ascKey ? descKey
               : sortKey === descKey ? 'imported_desc'
               : ascKey
    setSortKey(next)
    resetCursor(); load(null, { sort: next })
  }

  /** Render the correct sort icon for a column header. */
  const colSortIcon = (ascKey: string, descKey: string) => {
    if (sortKey === ascKey)  return <ChevronUp   className="h-3.5 w-3.5 ml-0.5 shrink-0 text-primary" />
    if (sortKey === descKey) return <ChevronDown  className="h-3.5 w-3.5 ml-0.5 shrink-0 text-primary" />
    return <ArrowUpDown className="h-3.5 w-3.5 ml-0.5 shrink-0 opacity-20 group-hover/th:opacity-60 transition-opacity" />
  }

  const doExport = useCallback(async () => {
    setExportLoading(true)
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format:        exportFmt,
          query:         q,
          domain,
          breach_name:   breach,
          tier_include:  tierInclude.join(','),
          tier_exclude:  tierExclude.join(','),
          login_type:    loginType,
          pw_mask:       pwMask.join(','),
          url_scheme:    urlScheme,
          is_corporate:  isCorporate ? '1' : '',
          sort:          sortKey,
          date_from:     dateFrom,
          date_to:       dateTo,
          pw_len_min:    pwLenMin !== '' ? parseInt(pwLenMin, 10) : null,
          pw_len_max:    pwLenMax !== '' ? parseInt(pwLenMax, 10) : null,
          email_domain:  emailDomainFilter,
          source_file:   sourceFileFilter,
          regex_mode:    regexMode,
        }),
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      const cd   = res.headers.get('Content-Disposition') || ''
      const m    = cd.match(/filename="([^"]+)"/)
      const ext  = exportFmt === 'csv' ? 'csv' : exportFmt === 'json' ? 'json' : exportFmt === 'ndjson' ? 'ndjson' : 'txt'
      a.download = m?.[1] || `credentials-export.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({ title: 'Export started' })
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' })
    } finally {
      setExportLoading(false)
    }
  }, [q, domain, breach, tierInclude, tierExclude, loginType, pwMask, urlScheme, isCorporate, sortKey, exportFmt,
      dateFrom, dateTo, pwLenMin, pwLenMax, emailDomainFilter, sourceFileFilter, urlHostFilter, regexMode,
      toast])

  const tierBadgeClass = (t: string) =>
    t === 'T1' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' :
    t === 'T2' ? 'bg-blue-500/10 text-blue-600 border-blue-500/20' :
    t === 'T3' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' : ''

  const hasBasicFilters = !!(q || domain || breach || loginType || pwMask.length || isCorporate || urlScheme || tierInclude.length || tierExclude.length)
  const hasAdvFilters   = !!(dateFrom || dateTo || pwLenMin || pwLenMax || emailDomainFilter || sourceFileFilter || urlHostFilter || regexMode)
  const hasFilters      = hasBasicFilters || hasAdvFilters

  const selectCls = "h-8 text-xs border border-border rounded-md bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
  const advInputCls = "h-7 text-xs font-mono"

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="border-b px-6 py-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-bold">Credentials Browser</h1>
            {data && (
              <>
                <p className="text-sm text-muted-foreground">
                  {data.total.toLocaleString()} records
                  {data.query_ms !== undefined && (
                    <span className={`ml-2 ${data.query_ms > 10_000 ? 'text-amber-500' : 'opacity-50'}`}>
                      {data.query_ms >= 1_000
                        ? `${(data.query_ms / 1_000).toFixed(1)}s`
                        : `${data.query_ms}ms`}
                    </span>
                  )}
                  <span className="ml-2 opacity-40 text-xs">· click any row to inspect</span>
                </p>
                {/* Slow/timed-out query warning */}
                {(data.timed_out || (data.query_ms !== undefined && data.query_ms > 25_000 && data.results.length === 0)) && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 flex items-center gap-1">
                    ⚠ Query was slow or may have been cut short at this data size.
                    Try a more specific filter (exact email, domain, or breach name).
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Sort */}
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <select
                value={sortKey}
                onChange={e => { const s = e.target.value; setSortKey(s); resetCursor(); load(null, { sort: s }) }}
                className={selectCls}
              >
                {SORT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Page size */}
            <select
              value={limit}
              onChange={e => { const l = Number(e.target.value); setLimit(l); resetCursor(); load(null, { limit: l }) }}
              className={selectCls}
              title="Rows per page"
            >
              {PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}
            </select>

            {/* Export */}
            <div className="flex items-center gap-1">
              <select
                value={exportFmt}
                onChange={e => setExportFmt(e.target.value)}
                className={selectCls}
                title="Export format"
              >
                {EXPORT_FORMATS.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={doExport}
                disabled={exportLoading}
                className="h-8 text-xs gap-1"
              >
                {exportLoading
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Download className="h-3 w-3" />
                }
                Export
              </Button>
            </div>

            <div className="h-5 w-px bg-border" />

            {hasFilters && (
              <Button size="sm" variant="ghost" onClick={clearAll} className="h-8 text-xs">
                <X className="mr-1 h-3.5 w-3.5" />Clear
              </Button>
            )}
            <Button size="sm" onClick={applyFilters} disabled={loading} className="h-8 text-xs">
              <Filter className="mr-1 h-3.5 w-3.5" />Apply
            </Button>
          </div>
        </div>

        {/* ── Filter row 1: text search + domain + breach ──────────────────── */}
        <div className="flex gap-2">
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            placeholder={regexMode ? 'RE2 regex pattern…' : 'Search URL / email / password…'}
            className="flex-1 font-mono text-sm h-8"
          />
          <Input
            value={domain}
            onChange={e => setDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            placeholder="Domain…"
            className="w-40 font-mono text-sm h-8"
          />
          <Input
            value={breach}
            onChange={e => setBreach(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            placeholder="Breach…"
            className="w-36 font-mono text-sm h-8"
          />
        </div>

        {/* ── Filter row 2: chip filters ───────────────────────────────────── */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Tier multi-select popover */}
          {(() => {
            // Helpers for 3-way tier state
            const getTierState = (t: string): 'include' | 'exclude' | 'off' =>
              tierInclude.includes(t) ? 'include' : tierExclude.includes(t) ? 'exclude' : 'off'
            const setTierToInclude = (t: string) => {
              setTierInclude(p => p.includes(t) ? p : [...p, t])
              setTierExclude(p => p.filter(x => x !== t))
            }
            const setTierToExclude = (t: string) => {
              setTierExclude(p => p.includes(t) ? p : [...p, t])
              setTierInclude(p => p.filter(x => x !== t))
            }
            const setTierOff = (t: string) => {
              setTierInclude(p => p.filter(x => x !== t))
              setTierExclude(p => p.filter(x => x !== t))
            }
            // Trigger label
            const tierParts = [
              ...tierInclude.map(t => t),
              ...tierExclude.map(t => `−${t}`),
            ]
            const tierActive = tierInclude.length > 0 || tierExclude.length > 0
            return (
              <Popover open={tierOpen} onOpenChange={setTierOpen}>
                <PopoverTrigger asChild>
                  <button className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${tierActive ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-muted/40 text-muted-foreground'}`}>
                    <Globe className="h-3 w-3" />
                    {tierActive ? tierParts.join(' ') : 'All tiers'}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-3" align="start">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2.5 font-medium">
                    Country tier
                  </p>
                  <div className="space-y-2">
                    {(['T1', 'T2', 'T3'] as const).map(t => {
                      const state = getTierState(t)
                      return (
                        <div key={t} className="flex items-center gap-2">
                          {/* Tier label */}
                          <span className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate">
                            <span className="font-mono font-semibold text-foreground">{t}</span>
                            {' — '}
                            {t === 'T1' ? 'US / UK / CA / AU' : t === 'T2' ? 'W. Europe / JP / KR' : 'RU / CN / BR / LATAM'}
                          </span>
                          {/* 3-way toggle */}
                          <div className="flex gap-0.5 shrink-0">
                            <button
                              onClick={() => setTierOff(t)}
                              title="No filter (off)"
                              className={`h-6 px-1.5 rounded text-[10px] border transition-colors ${state === 'off' ? 'bg-muted text-foreground border-border font-medium' : 'text-muted-foreground/50 border-transparent hover:border-border hover:text-muted-foreground'}`}
                            >○</button>
                            <button
                              onClick={() => setTierToInclude(t)}
                              title="Include — show only this tier"
                              className={`h-6 px-1.5 rounded text-[10px] border transition-colors ${state === 'include' ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30 font-semibold' : 'text-muted-foreground/50 border-transparent hover:border-emerald-500/30 hover:text-emerald-600'}`}
                            >✓</button>
                            <button
                              onClick={() => setTierToExclude(t)}
                              title="Exclude — hide this tier"
                              className={`h-6 px-1.5 rounded text-[10px] border transition-colors ${state === 'exclude' ? 'bg-rose-500/15 text-rose-600 border-rose-500/30 font-semibold' : 'text-muted-foreground/50 border-transparent hover:border-rose-500/30 hover:text-rose-600'}`}
                            >✗</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  {/* Legend */}
                  <div className="mt-3 pt-2.5 border-t border-border/50 flex gap-3 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="text-foreground/50">○</span> off</span>
                    <span className="flex items-center gap-1"><span className="text-emerald-600 font-semibold">✓</span> include only</span>
                    <span className="flex items-center gap-1"><span className="text-rose-600 font-semibold">✗</span> exclude</span>
                  </div>
                  {tierActive && (
                    <button
                      onClick={() => { setTierInclude([]); setTierExclude([]) }}
                      className="mt-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Reset to all tiers
                    </button>
                  )}
                </PopoverContent>
              </Popover>
            )
          })()}

          {/* Login type */}
          {LOGIN_TYPE_OPTIONS.map(lt => (
            <button
              key={lt || 'all-lt'}
              onClick={() => setLoginType(loginType === lt ? '' : lt)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${loginType === lt ? 'border-primary/30 bg-primary/10 text-primary font-medium' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}
            >
              {lt === '' ? 'All types' : LOGIN_TYPE_SHORT[lt] ?? lt}
            </button>
          ))}

          <div className="h-4 w-px bg-border" />

          {/* Password mask */}
          {MASK_OPTIONS.map(mask => {
            const active = pwMask.includes(mask)
            return (
              <button
                key={mask}
                onClick={() => setPwMask(prev => active ? prev.filter(m => m !== mask) : [...prev, mask])}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? MASK_COLORS[mask] + ' font-medium' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}
              >
                {mask}
              </button>
            )
          })}

          <div className="h-4 w-px bg-border" />

          {/* Scheme */}
          {['', 'https', 'http'].map(scheme => (
            <button
              key={scheme || 'any'}
              onClick={() => setUrlScheme(urlScheme === scheme ? '' : scheme)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${urlScheme === scheme && scheme !== '' ? 'border-primary/30 bg-primary/10 text-primary font-medium' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}
            >
              {scheme || 'Any scheme'}
            </button>
          ))}

          {/* Corporate */}
          <button
            onClick={() => setIsCorporate(!isCorporate)}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${isCorporate ? 'border-orange-400/40 bg-orange-500/10 text-orange-600 font-medium' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}
          >
            🏢 Corporate only
          </button>

          <div className="h-4 w-px bg-border" />

          {/* Advanced filters toggle */}
          <button
            onClick={() => setAdvOpen(!advOpen)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${hasAdvFilters ? 'border-primary/30 bg-primary/10 text-primary font-medium' : advOpen ? 'border-border bg-muted text-foreground' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}
          >
            <SlidersHorizontal className="h-3 w-3" />
            Advanced
            {hasAdvFilters && <span className="ml-0.5 text-[10px] font-bold">●</span>}
          </button>
        </div>

        {/* ── Advanced filters panel ───────────────────────────────────────── */}
        {advOpen && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-3 mt-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Advanced Filters
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {/* Date range */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">From date</label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className={advInputCls}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">To date</label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className={advInputCls}
                />
              </div>

              {/* Password length range */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Min pw length</label>
                <Input
                  type="number"
                  min={1}
                  max={512}
                  value={pwLenMin}
                  onChange={e => setPwLenMin(e.target.value)}
                  placeholder="e.g. 8"
                  className={advInputCls}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Max pw length</label>
                <Input
                  type="number"
                  min={1}
                  max={512}
                  value={pwLenMax}
                  onChange={e => setPwLenMax(e.target.value)}
                  placeholder="e.g. 64"
                  className={advInputCls}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {/* Email domain */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Email domain</label>
                <Input
                  value={emailDomainFilter}
                  onChange={e => setEmailDomainFilter(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyFilters()}
                  placeholder="e.g. gmail.com"
                  className={advInputCls}
                />
              </div>

              {/* Source file */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Source file</label>
                <Input
                  value={sourceFileFilter}
                  onChange={e => setSourceFileFilter(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyFilters()}
                  placeholder="e.g. dump_2024.txt"
                  className={advInputCls}
                />
              </div>

              {/* URL host */}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">URL host</label>
                <Input
                  value={urlHostFilter}
                  onChange={e => setUrlHostFilter(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyFilters()}
                  placeholder="e.g. accounts.google.com"
                  className={advInputCls}
                />
              </div>
            </div>

            {/* Regex mode toggle */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRegexMode(!regexMode)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${regexMode ? 'border-violet-400/40 bg-violet-500/10 text-violet-600 font-medium' : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'}`}
              >
                <span className="font-mono font-bold">.*</span>
                {regexMode ? 'RE2 regex ON' : 'RE2 regex mode'}
              </button>
              {regexMode && (
                <span className="text-[10px] text-muted-foreground">
                  The search box accepts RE2-compatible patterns. Applied to URL, email, and password.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : data && data.results.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background border-b z-10">
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th
                  className="group/th px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground transition-colors"
                  onClick={() => cycleSortKey('domain_asc', 'domain_desc')}
                  title="Sort by domain"
                >
                  <span className="flex items-center">
                    URL {colSortIcon('domain_asc', 'domain_desc')}
                  </span>
                </th>
                <th
                  className="group/th px-4 py-2 font-medium cursor-pointer select-none hover:text-foreground transition-colors"
                  onClick={() => cycleSortKey('email_asc', 'email_desc')}
                  title="Sort by email / login"
                >
                  <span className="flex items-center">
                    Email / Login {colSortIcon('email_asc', 'email_desc')}
                  </span>
                </th>
                <th className="px-4 py-2 font-medium">Password</th>
                <th
                  className="group/th px-4 py-2 font-medium w-32 cursor-pointer select-none hover:text-foreground transition-colors"
                  onClick={() => cycleSortKey('domain_asc', 'domain_desc')}
                  title="Sort by domain"
                >
                  <span className="flex items-center">
                    Domain {colSortIcon('domain_asc', 'domain_desc')}
                  </span>
                </th>
                <th className="px-4 py-2 font-medium w-14">Tier</th>
                <th className="px-4 py-2 font-medium w-24">Mask</th>
                <th
                  className="group/th px-4 py-2 font-medium w-12 cursor-pointer select-none hover:text-foreground transition-colors"
                  onClick={() => cycleSortKey('pw_len_asc', 'pw_len_desc')}
                  title="Sort by password length"
                >
                  <span className="flex items-center">
                    Len {colSortIcon('pw_len_asc', 'pw_len_desc')}
                  </span>
                </th>
                <th className="px-4 py-2 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((cred, i) => (
                <tr
                  key={i}
                  className={`border-b hover:bg-muted/40 group cursor-pointer transition-colors ${selectedCred === cred && sheetOpen ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`}
                  onClick={() => openDetail(cred)}
                >
                  <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-muted-foreground" title={cred.url}>
                    {cred.url}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 font-mono text-xs" title={cred.email}>
                    {cred.email}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 font-mono text-xs font-medium" title={cred.password}>
                    {cred.password}
                  </td>
                  <td className="px-4 py-2">
                    <Badge
                      variant="outline"
                      className="text-xs font-normal max-w-[8rem] truncate block"
                      title={cred.breach_name ? `${cred.domain} · ${cred.breach_name}` : cred.domain}
                    >
                      {cred.domain}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">
                    {cred.country_tier ? (
                      <span className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded border ${tierBadgeClass(cred.country_tier)}`}>
                        {cred.country_tier}
                      </span>
                    ) : <span className="text-muted-foreground/30 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    {cred.password_mask ? (
                      <span className={`text-xs px-1.5 py-0.5 rounded border ${MASK_COLORS[cred.password_mask] || ''}`}>
                        {cred.password_mask}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground tabular-nums">
                    {cred.password_length}
                  </td>
                  <td className="px-2 py-2">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={e => { e.stopPropagation(); copy(`${cred.email}:${cred.password}`) }}
                      title="Copy email:password"
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex h-full items-center justify-center text-center p-6">
            {loading ? null : (
              // count>0 but results=0 means the data query timed out (timeout_overflow_mode=break
              // flushes 0 rows when ORDER BY query is interrupted mid-sort).
              data && data.total > 0
                ? (
                  <div className="space-y-2">
                    <p className="text-amber-600 dark:text-amber-400 font-medium">
                      ⚠ Results timed out on this page
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {data.total.toLocaleString()} records were found but couldn't be loaded — go back to the first page or add a more specific filter.
                    </p>
                  </div>
                )
                : <span className="text-muted-foreground text-sm">No credentials found</span>
            )}
          </div>
        )}
      </div>

      {/* ── Pagination ─────────────────────────────────────────────────────── */}
      {(cursorStack.length > 0 || data?.next_cursor) && (
        <div className="flex items-center justify-center gap-3 border-t px-4 py-3">
          <Button
            size="sm" variant="outline"
            disabled={cursorStack.length === 0 || loading}
            onClick={() => {
              const prev = cursorStack[cursorStack.length - 1] ?? null
              setCursorStack(s => s.slice(0, -1))
              load(prev)
            }}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {data?.total.toLocaleString()} results
          </span>
          <Button
            size="sm" variant="outline"
            disabled={!data?.next_cursor || loading}
            onClick={() => {
              const next = data!.next_cursor!
              setCursorStack(s => [...s, currentCursor])
              load(next)
            }}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* ── Credential detail sheet ─────────────────────────────────────────── */}
      <CredentialDetailSheet
        cred={selectedCred}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSearchEmail={handleSearchEmail}
        onSearchDomain={handleSearchDomain}
      />
    </div>
  )
}
