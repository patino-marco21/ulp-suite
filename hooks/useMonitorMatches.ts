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

interface MatchesApiResponse {
  success: boolean
  results?: MonitorMatchRow[]
  limited?: boolean
  new_count?: number
  checked_at?: string | null
  never_scanned?: boolean
  last_error?: string | null
  error?: string
}

export function useMonitorMatches() {
  const { toast } = useToast()

  const [matchesMonitor, setMatchesMonitor] = useState<MonitorMatchTarget | null>(null)
  const [matches, setMatches] = useState<MonitorMatchRow[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesLimited, setMatchesLimited] = useState(false)
  const [matchesNewCount, setMatchesNewCount] = useState(0)
  // Distinct from "loaded, zero rows" on purpose — see the dialog's render
  // branches. An empty table must never stand in for a failed request.
  const [matchesError, setMatchesError] = useState<string | null>(null)
  // Cache metadata (this endpoint reads a cache now, see Task 9) — distinct
  // from matchesError, which is for the GET/POST request itself failing.
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [neverScanned, setNeverScanned] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState(false)
  // Only the newest request may write state. A cold phase-1 cache used to
  // make this seconds long; now a rescan does, so the guard still matters.
  const matchesRequestId = useRef(0)

  const applyResult = (data: MatchesApiResponse) => {
    setMatches(data.results || [])
    setMatchesLimited(Boolean(data.limited))
    setMatchesNewCount(data.new_count || 0)
    setCheckedAt(data.checked_at ?? null)
    setNeverScanned(Boolean(data.never_scanned))
    setLastError(data.last_error ?? null)
  }

  const openMatches = async (monitor: MonitorMatchTarget) => {
    const requestId = ++matchesRequestId.current
    setMatchesMonitor(monitor)
    setMatchesLoading(true)
    setMatches([])
    setMatchesLimited(false)
    setMatchesNewCount(0)
    setMatchesError(null)
    setCheckedAt(null)
    setNeverScanned(false)
    setLastError(null)
    try {
      const res = await fetch(`/api/monitoring/monitors/${monitor.id}/matches`)
      const data: MatchesApiResponse = await res.json()
      if (requestId !== matchesRequestId.current) return
      if (data.success) {
        applyResult(data)
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

  const rescanNow = async () => {
    if (!matchesMonitor) return
    const requestId = ++matchesRequestId.current
    setRescanning(true)
    try {
      const res = await fetch(`/api/monitoring/monitors/${matchesMonitor.id}/matches/rescan`, { method: 'POST' })
      const data: MatchesApiResponse = await res.json()
      if (requestId !== matchesRequestId.current) return
      if (data.success) {
        setMatchesError(null)
        applyResult(data)
      } else {
        const message = data.error || "The rescan failed."
        toast({ title: "Rescan failed", description: message, variant: "destructive" })
      }
    } catch {
      if (requestId !== matchesRequestId.current) return
      toast({ title: "Rescan failed", description: "Could not reach the server.", variant: "destructive" })
    } finally {
      if (requestId === matchesRequestId.current) setRescanning(false)
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
    checkedAt,
    neverScanned,
    lastError,
    rescanning,
    openMatches,
    closeMatches,
    rescanNow,
  }
}
