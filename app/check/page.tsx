"use client"
export const dynamic = "force-dynamic"

import { useState, FormEvent } from "react"
import { Shield, ShieldAlert, ShieldCheck, Loader2, Search, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

interface BreachEntry {
  name: string
  domains: string[]
  first_seen: string
}

interface CheckResult {
  success: boolean
  email: string
  found: boolean
  breach_count: number
  breaches: BreachEntry[]
  error?: string
}

export default function CheckPage() {
  const [email, setEmail]       = useState("")
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<CheckResult | null>(null)
  const [error, setError]       = useState<string | null>(null)

  async function handleCheck(e: FormEvent) {
    e.preventDefault()
    const q = email.trim().toLowerCase()
    if (!q || !q.includes("@")) return

    setLoading(true)
    setResult(null)
    setError(null)

    try {
      const res  = await fetch(`/api/check?email=${encodeURIComponent(q)}`)
      const json: CheckResult = await res.json()

      if (!json.success) {
        setError(json.error || "Lookup failed")
      } else {
        setResult(json)
      }
    } catch {
      setError("Network error — please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav bar */}
      <header className="border-b px-6 py-3 flex items-center gap-3">
        <Shield className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">ULP Suite · Email Check</span>
        <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1">
          <Lock className="h-3 w-3" />
          Passwords are never exposed
        </span>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center px-4 pt-16 pb-12">
        <div className="w-full max-w-lg space-y-8">
          {/* Title */}
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-bold tracking-tight">
              Has your email been breached?
            </h1>
            <p className="text-muted-foreground">
              Enter your email address to check if it appears in any known data breaches.
              <br />
              <span className="text-xs">Only breach names are returned — your password is never shown.</span>
            </p>
          </div>

          {/* Search form */}
          <form onSubmit={handleCheck} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="pl-9"
                autoComplete="email"
                required
              />
            </div>
            <Button type="submit" disabled={loading || !email.includes("@")}>
              {loading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : "Check"
              }
            </Button>
          </form>

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Result: not found */}
          {result && !result.found && (
            <div className="rounded-xl border border-green-500/30 bg-green-500/5 px-6 py-8 text-center space-y-3">
              <ShieldCheck className="h-12 w-12 text-green-500 mx-auto" />
              <div>
                <p className="font-semibold text-lg">Good news!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  <span className="font-mono text-foreground">{result.email}</span> was not found
                  in any breaches in our database.
                </p>
              </div>
            </div>
          )}

          {/* Result: found */}
          {result && result.found && (
            <div className="space-y-4">
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-6 text-center space-y-3">
                <ShieldAlert className="h-12 w-12 text-destructive mx-auto" />
                <div>
                  <p className="font-semibold text-lg">Email found in breaches</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    <span className="font-mono text-foreground">{result.email}</span> appears in{" "}
                    <strong>{result.breach_count}</strong> breach{result.breach_count !== 1 ? "es" : ""}.
                    Change your passwords on the affected services.
                  </p>
                </div>
              </div>

              {/* Breach list */}
              <div className="divide-y rounded-lg border overflow-hidden">
                {result.breaches.map((b, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <ShieldAlert className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{b.name || "Unknown source"}</p>
                      {b.domains.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {b.domains.map(d => (
                            <Badge key={d} variant="secondary" className="text-xs font-normal">
                              {d}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(b.first_seen).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>

              <p className="text-xs text-center text-muted-foreground">
                We recommend changing your password on all listed services and enabling two-factor authentication.
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t px-6 py-4 text-center text-xs text-muted-foreground">
        Breach names only — passwords are never exposed or stored by this service
      </footer>
    </div>
  )
}
