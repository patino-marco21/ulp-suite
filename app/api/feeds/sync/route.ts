import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { dbQuery, dbRun } from "@/lib/sqlite"

export const dynamic = "force-dynamic"

interface FeedSource {
  id: number
  name: string
  rss_url: string
  category_name: string
}

interface SyncResult {
  id: number
  name: string
  url: string
  status: "ok" | "error"
  item_count?: number
  error?: string
}

/**
 * Lightweight RSS/Atom item counter — does NOT store items,
 * just validates the feed is reachable and parseable, and
 * updates `last_fetched_at` in the DB.
 *
 * A full ingestion pipeline (storing feed items) would require a
 * separate feed_items table and is outside this route's scope.
 */
async function fetchAndCountItems(url: string): Promise<number> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "ULPSuite-FeedSync/1.0" },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const xml = await res.text()

    // Count <item> tags (RSS 2.0) or <entry> tags (Atom)
    const rssItems  = (xml.match(/<item[\s>]/gi)  ?? []).length
    const atomItems = (xml.match(/<entry[\s>]/gi) ?? []).length
    return rssItems + atomItems
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * POST /api/feeds/sync
 * Iterates all feed sources, fetches each RSS URL, counts items,
 * and stamps last_fetched_at. Returns a per-source summary.
 */
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const sources = dbQuery(
      `SELECT s.id, s.name, s.rss_url, c.name AS category_name
       FROM feed_sources s
       JOIN feed_categories c ON c.id = s.category_id
       ORDER BY c.name ASC, s.name ASC`
    ) as FeedSource[]

    if (sources.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No feed sources configured.",
        synced: 0,
        results: [],
      })
    }

    // Fetch all feeds concurrently (max 5 at a time to avoid hammering)
    const CONCURRENCY = 5
    const results: SyncResult[] = []

    for (let i = 0; i < sources.length; i += CONCURRENCY) {
      const batch = sources.slice(i, i + CONCURRENCY)
      const settled = await Promise.allSettled(
        batch.map(async (src) => {
          const count = await fetchAndCountItems(src.rss_url)
          dbRun(
            `UPDATE feed_sources SET last_fetched_at = datetime('now') WHERE id = ?`,
            [src.id]
          )
          return { id: src.id, name: src.name, url: src.rss_url, status: "ok" as const, item_count: count }
        })
      )
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j]
        if (s.status === "fulfilled") {
          results.push(s.value)
        } else {
          const src = batch[j]
          results.push({
            id: src.id,
            name: src.name,
            url: src.rss_url,
            status: "error",
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          })
        }
      }
    }

    const ok    = results.filter(r => r.status === "ok").length
    const failed = results.filter(r => r.status === "error").length

    return NextResponse.json({
      success: true,
      message: `Synced ${ok} source${ok !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}.`,
      synced: ok,
      failed,
      results,
    })
  } catch (error) {
    console.error("POST /api/feeds/sync error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    )
  }
}
