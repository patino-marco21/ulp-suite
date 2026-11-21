"use client"

import { ArrowUpRight } from "lucide-react"
import { siteUrl } from "@/lib/site-url"

interface SiteLinkProps {
  /** The host the counts name (never what was pasted: see lib/site-url.ts). */
  host: string
  /** Words next to the arrow, for a place with room (the mark editor's header). Without it the link is the arrow alone. */
  label?: string
}

/**
 * The arrow beside a domain: opens the site's front page in another tab. A real link, so middle-click, copy-link and Enter work; the opened site is not
 * told which app it came from. Nothing at all for a host that is not a plain host.
 */
export function SiteLink({ host, label }: SiteLinkProps) {
  const href = siteUrl(host)
  if (href === null) return null
  const name = `Open ${host} in a new tab`
  return (
    // The row it sits in opens its detail on a click: the arrow is not a click on the row.
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      aria-label={name}
      title={name}
      onClick={event => event.stopPropagation()}
      className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
    </a>
  )
}
