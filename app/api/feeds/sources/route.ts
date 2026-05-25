import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { dbQuery, dbGet, dbRun } from "@/lib/sqlite"

export const dynamic = "force-dynamic"

/**
 * GET /api/feeds/sources[?category_id=N]
 * Returns all feed sources, optionally filtered by category.
 */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const sp         = new URL(request.url).searchParams
    const categoryId = sp.get("category_id")

    let sources: unknown[]
    if (categoryId) {
      sources = dbQuery(
        `SELECT s.id, s.category_id, s.name, s.rss_url, s.last_fetched_at, s.created_at, s.updated_at,
                c.name AS category_name, c.slug AS category_slug
         FROM feed_sources s
         JOIN feed_categories c ON c.id = s.category_id
         WHERE s.category_id = ?
         ORDER BY s.name ASC`,
        [Number(categoryId)]
      )
    } else {
      sources = dbQuery(
        `SELECT s.id, s.category_id, s.name, s.rss_url, s.last_fetched_at, s.created_at, s.updated_at,
                c.name AS category_name, c.slug AS category_slug
         FROM feed_sources s
         JOIN feed_categories c ON c.id = s.category_id
         ORDER BY c.name ASC, s.name ASC`
      )
    }

    return NextResponse.json({ success: true, sources })
  } catch (error) {
    console.error("GET /api/feeds/sources error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load sources" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/feeds/sources
 * Body: { category_id: number, name: string, rss_url: string }
 */
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const body       = await request.json()
    const categoryId = Number(body.category_id)
    const name       = (body.name    ?? "").trim()
    const rssUrl     = (body.rss_url ?? "").trim()

    if (!categoryId || !name || !rssUrl) {
      return NextResponse.json(
        { success: false, error: "category_id, name, and rss_url are required" },
        { status: 400 }
      )
    }

    // Validate category exists
    const cat = dbGet(`SELECT id FROM feed_categories WHERE id = ?`, [categoryId])
    if (!cat) {
      return NextResponse.json({ success: false, error: "Category not found" }, { status: 404 })
    }

    // Basic URL validation
    try { new URL(rssUrl) } catch {
      return NextResponse.json({ success: false, error: "rss_url must be a valid URL" }, { status: 400 })
    }

    const { lastId } = dbRun(
      `INSERT INTO feed_sources (category_id, name, rss_url) VALUES (?, ?, ?)`,
      [categoryId, name, rssUrl]
    )

    const created = dbGet(
      `SELECT s.id, s.category_id, s.name, s.rss_url, s.last_fetched_at, s.created_at,
              c.name AS category_name
       FROM feed_sources s JOIN feed_categories c ON c.id = s.category_id
       WHERE s.id = ?`,
      [lastId]
    )
    return NextResponse.json({ success: true, source: created }, { status: 201 })
  } catch (error) {
    console.error("POST /api/feeds/sources error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create source" },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/feeds/sources
 * Body: { id: number, name?: string, rss_url?: string, category_id?: number }
 */
export async function PUT(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const body = await request.json()
    const id   = Number(body.id)
    if (!id) {
      return NextResponse.json({ success: false, error: "id is required" }, { status: 400 })
    }

    const existing = dbGet(`SELECT id FROM feed_sources WHERE id = ?`, [id]) as { id: number } | undefined
    if (!existing) {
      return NextResponse.json({ success: false, error: "Source not found" }, { status: 404 })
    }

    const sets: string[] = []
    const vals: unknown[] = []

    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return NextResponse.json({ success: false, error: "name cannot be empty" }, { status: 400 })
      sets.push("name = ?")
      vals.push(name)
    }
    if (body.rss_url !== undefined) {
      const rssUrl = String(body.rss_url).trim()
      try { new URL(rssUrl) } catch {
        return NextResponse.json({ success: false, error: "rss_url must be a valid URL" }, { status: 400 })
      }
      sets.push("rss_url = ?")
      vals.push(rssUrl)
    }
    if (body.category_id !== undefined) {
      const catId = Number(body.category_id)
      const cat = dbGet(`SELECT id FROM feed_categories WHERE id = ?`, [catId])
      if (!cat) return NextResponse.json({ success: false, error: "Category not found" }, { status: 404 })
      sets.push("category_id = ?")
      vals.push(catId)
    }

    if (sets.length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 })
    }

    sets.push("updated_at = datetime('now')")
    vals.push(id)

    dbRun(`UPDATE feed_sources SET ${sets.join(", ")} WHERE id = ?`, vals)

    const updated = dbGet(
      `SELECT s.id, s.category_id, s.name, s.rss_url, s.last_fetched_at, s.updated_at,
              c.name AS category_name
       FROM feed_sources s JOIN feed_categories c ON c.id = s.category_id
       WHERE s.id = ?`,
      [id]
    )
    return NextResponse.json({ success: true, source: updated })
  } catch (error) {
    console.error("PUT /api/feeds/sources error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update source" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/feeds/sources?id=N
 */
export async function DELETE(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const id = Number(new URL(request.url).searchParams.get("id"))
    if (!id) {
      return NextResponse.json({ success: false, error: "id query parameter is required" }, { status: 400 })
    }

    const existing = dbGet(`SELECT id FROM feed_sources WHERE id = ?`, [id])
    if (!existing) {
      return NextResponse.json({ success: false, error: "Source not found" }, { status: 404 })
    }

    const { changes } = dbRun(`DELETE FROM feed_sources WHERE id = ?`, [id])
    return NextResponse.json({ success: true, deleted: changes })
  } catch (error) {
    console.error("DELETE /api/feeds/sources error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete source" },
      { status: 500 }
    )
  }
}
