"use client"

import Link from "next/link"
import { Eye } from "lucide-react"
import { jobViewLink, type JobForLink } from "@/lib/imported-window"

/**
 * "View what this added": the Credentials page filtered to the rows one import job added (its time window, and its file when it is a plain
 * .txt / .csv or an archive reference). A ZIP gets the window only, and the tooltip says that rows of files imported at the same time can be in it.
 * Nothing for a job that added no rows. Design: docs/superpowers/specs/2026-10-18-imported-window-ux-design.md.
 */
export function JobViewLink({ job }: { job: JobForLink }) {
  const link = jobViewLink(job)
  if (!link) return null
  return (
    <Link
      href={link.href}
      title={link.exact ? "View what this added" : "View the rows added while this job ran (rows of files imported at the same time can be included)"}
      aria-label={`View what ${job.filename} added`}
      className="shrink-0 rounded p-1 -m-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Eye className="h-3 w-3" />
    </Link>
  )
}
