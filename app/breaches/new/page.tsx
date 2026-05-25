"use client"
export const dynamic = "force-dynamic"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ShieldAlert, ArrowLeft, Plus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { useAuth, isAdmin } from "@/hooks/useAuth"

export default function NewBreachPage() {
  const { user } = useAuth(true)
  const { toast } = useToast()
  const router = useRouter()

  const [saving, setSaving] = useState(false)
  const [dataClassInput, setDataClassInput] = useState('')
  const [patternInput, setPatternInput] = useState('')
  const [form, setForm] = useState({
    breach_name: '',
    title: '',
    domain: '',
    breach_date: '',
    pwn_count: '',
    description: '',
    data_classes: [] as string[],
    source_file_patterns: [] as string[],
    is_verified: false,
    is_fabricated: false,
    is_sensitive: false,
    is_spam_list: false,
    is_malware: false,
    is_stealer_log: false,
    is_mega_dump: false,
  })

  const userIsAdmin = user ? isAdmin(user) : false

  const set = (key: keyof typeof form, value: unknown) =>
    setForm(f => ({ ...f, [key]: value }))

  const addDataClass = () => {
    const dc = dataClassInput.trim()
    if (!dc || form.data_classes.includes(dc)) return
    set('data_classes', [...form.data_classes, dc])
    setDataClassInput('')
  }

  const addPattern = () => {
    const p = patternInput.trim()
    if (!p || form.source_file_patterns.includes(p)) return
    set('source_file_patterns', [...form.source_file_patterns, p])
    setPatternInput('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.breach_name.trim() || !form.title.trim()) {
      toast({ title: 'Name and title are required', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/breaches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          pwn_count: form.pwn_count ? parseInt(form.pwn_count, 10) : 0,
        }),
      })
      const json = await res.json()
      if (json.success) {
        toast({ title: 'Breach created' })
        router.push(`/breaches/${encodeURIComponent(form.breach_name.trim())}`)
      } else {
        toast({ title: json.error || 'Failed to create breach', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Failed to create breach', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (!userIsAdmin) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Admin access required.
      </div>
    )
  }

  const boolFlags = [
    { key: 'is_verified', label: 'Verified' },
    { key: 'is_fabricated', label: 'Fabricated' },
    { key: 'is_sensitive', label: 'Sensitive' },
    { key: 'is_spam_list', label: 'Spam list' },
    { key: 'is_malware', label: 'Malware' },
    { key: 'is_stealer_log', label: 'Stealer log' },
    { key: 'is_mega_dump', label: 'Mega-dump' },
  ] as const

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6 max-w-2xl mx-auto">
      <div>
        <Button variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground" onClick={() => router.push('/breaches')}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Back to breaches
        </Button>
        <h1 className="text-2xl font-bold flex items-center gap-3">
          <div className="p-2 rounded-xl bg-red-500/10">
            <ShieldAlert className="h-6 w-6 text-red-500" />
          </div>
          New Breach
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Manually create a breach record for tagging credentials.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="glass-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">
                Breach Name <span className="text-red-500">*</span>
              </label>
              <Input
                value={form.breach_name}
                onChange={e => set('breach_name', e.target.value)}
                placeholder="LinkedIn2012"
                className="font-mono"
                required
              />
              <p className="text-[10px] text-muted-foreground/60 mt-1">Internal key used for tagging — no spaces, no special chars</p>
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">
                Title <span className="text-red-500">*</span>
              </label>
              <Input
                value={form.title}
                onChange={e => set('title', e.target.value)}
                placeholder="LinkedIn 2012"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">Domain</label>
                <Input
                  value={form.domain}
                  onChange={e => set('domain', e.target.value)}
                  placeholder="linkedin.com"
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">Breach Date</label>
                <Input
                  value={form.breach_date}
                  onChange={e => set('breach_date', e.target.value)}
                  placeholder="2012-05-05"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">HIBP Pwn Count</label>
              <Input
                type="number"
                min={0}
                value={form.pwn_count}
                onChange={e => set('pwn_count', e.target.value)}
                placeholder="164611595"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">Description</label>
              <textarea
                value={form.description}
                onChange={e => set('description', e.target.value)}
                placeholder="In 2012, LinkedIn suffered a data breach..."
                rows={3}
                className="w-full text-sm rounded-md border bg-background px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">Data Classes</label>
              <div className="flex gap-2 mb-2">
                <Input
                  value={dataClassInput}
                  onChange={e => setDataClassInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDataClass())}
                  placeholder="Passwords, Email addresses…"
                  className="text-sm"
                />
                <Button type="button" size="sm" variant="outline" onClick={addDataClass}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              {form.data_classes.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.data_classes.map(dc => (
                    <Badge
                      key={dc}
                      variant="secondary"
                      className="text-xs cursor-pointer hover:opacity-60"
                      onClick={() => set('data_classes', form.data_classes.filter(d => d !== dc))}
                    >
                      {dc} ×
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1.5 block">Source File Patterns</label>
              <div className="flex gap-2 mb-2">
                <Input
                  value={patternInput}
                  onChange={e => setPatternInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addPattern())}
                  placeholder="linkedin_*.txt"
                  className="text-sm font-mono"
                />
                <Button type="button" size="sm" variant="outline" onClick={addPattern}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              {form.source_file_patterns.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.source_file_patterns.map(p => (
                    <Badge
                      key={p}
                      variant="outline"
                      className="text-xs font-mono cursor-pointer hover:opacity-60"
                      onClick={() => set('source_file_patterns', form.source_file_patterns.filter(x => x !== p))}
                    >
                      {p} ×
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Flags</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {boolFlags.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={form[key]}
                    onChange={e => set(key, e.target.checked)}
                    className="rounded border-border accent-primary"
                  />
                  <span className="text-sm group-hover:text-foreground text-muted-foreground transition-colors">{label}</span>
                </label>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3 justify-end">
          <Button type="button" variant="outline" onClick={() => router.push('/breaches')}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Create Breach
          </Button>
        </div>
      </form>
    </div>
  )
}
