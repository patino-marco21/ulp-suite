"use client"

import { useState, useRef } from "react"
import { useToast } from "@/hooks/use-toast"

export interface MonitorMatchTarget {
  id: number
  name: string
}

export interface MonitorMatchRow {
  url: string
  email: string
  password: string
  domain: string
  is_new: boolean
}

export function useMonitorMatches() {
  const { toast } = useToast()

  const [matchesMonitor, setMatchesMonitor] = useState<MonitorMatchTarget | null>(null)
  const [matches, setMatches] = useState<MonitorMatchRow[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
  const [matchesNewCount, setMatchesNewCount] = useState(0)
  // Distinct from "loaded, zero rows" on purpose — see the dialog's render
  // branches. An empty table must never stand in for a failed query.
  const [matchesError, setMatchesError] = useState<string | null>(null)
  // Only the newest openMatches call may write state. A cold phase-1 cache
  // makes this request seconds long, so switching monitors mid-flight would
  // otherwise let the first monitor's response land in the second's dialog.
  const matchesRequestId = useRef(0)

  const openMatches = async (monitor: MonitorMatchTarget) => {
    const requestId = ++matchesRequestId.current
    setMatchesMonitor(monitor)
    setMatchesLoading(true)
    setMatches([])
    setMatchesLimited(false)
    setMatchesNewCount(0)
    setMatchesError(null)
    try {
      const res = await fetch(`/api/monitoring/monitors/${monitor.id}/matches`)
      const data = await res.json()
      if (requestId !== matchesRequestId.current) return
      if (data.success) {
        setMatches(data.results || [])
        setMatchesLimited(Boolean(data.limited))
        setMatchesNewCount(data.new_count || 0)
      } else {
        const message = data.error || "The match query failed. Results below are unavailable — this is not a confirmation that nothing matches."
        setMatchesError(message)
        toast({ title: "Failed to load matches", description: message, variant: "destructive" })
      }
    } catch {
      if (requestId !== matchesRequestId.current) return
      setMatchesError("Could not reach the server. Results are unavailable — this is not a confirmation that nothing matches.")
      toast({ title: "Failed to load matches", variant: "destructive" })
    } finally {
      if (requestId === matchesRequestId.current) setMatchesLoading(false)
    }
  }

  const closeMatches = () => setMatchesMonitor(null)

  return {
    matchesMonitor,
    matches,
    matchesLoading,
    matchesLimited,
    matchesNewCount,
    matchesError,
    openMatches,
    closeMatches,
  }
}
