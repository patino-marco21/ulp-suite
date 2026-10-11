"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { describeDiskBanner, type DiskBanner as DiskBannerState, type DiskBannerPayload } from "@/lib/disk-banner"

const POLL_MS = 60_000

const STYLES: Record<DiskBannerState["level"], string> = {
  warn: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800",
  critical: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-100 dark:border-red-800",
  paused: "bg-red-100 text-red-900 border-red-300 dark:bg-red-950 dark:text-red-100 dark:border-red-800",
}

/** A strip under the header, on every page, while the disk is low or imports are paused for lack of space. */
export default function DiskBanner() {
  const [banner, setBanner] = useState<DiskBannerState | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      if (document.visibilityState !== "visible") return
      try {
        const res = await fetch("/api/monitoring/disk", { cache: "no-store" })
        if (cancelled) return
        if (!res.ok) {
          // 401 (logged out) or 403 (not an admin): there is nothing to show this viewer.
          setBanner(null)
          return
        }
        const data = (await res.json()) as DiskBannerPayload
        if (!cancelled) setBanner(describeDiskBanner(data.disk, data.gate))
      } catch {
        /* a network blip keeps whatever the last poll showed */
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") poll()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  if (!banner) return null
  return (
    <div
      role={banner.level === "warn" ? "status" : "alert"}
      data-testid="disk-banner"
      data-level={banner.level}
      className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${STYLES[banner.level]}`}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{banner.message}</span>
      <Link href="/upload" className="shrink-0 underline underline-offset-2">
        Ingest Health
      </Link>
    </div>
  )
}
