import { NextRequest, NextResponse } from "next/server"
import { validateRequest, requireAdminRole } from "@/lib/auth"
import { dbQuery, dbGet, dbRun } from "@/lib/sqlite"

export const dynamic = "force-dynamic"

/**
 * GET /api/feeds/categories
 * Returns all feed categories ordered by name.
 */
export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const categories = dbQuery(
      `SELECT id, name, slug, created_at, updated_at
       FROM feed_categories
       ORDER BY name ASC`
    )
    return NextResponse.json({ success: true, categories })
  } catch (error) {
    console.error("GET /api/feeds/categories error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load categories" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/feeds/categories
 * Body: { name: string, slug: string }
 * Creates a new feed category.
 */
export async function POST(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const roleError = requireAdminRole(user)
  if (roleError) return roleError

  try {
    const body = await request.json()
    const name = (body.name ?? "").trim()
    const slug = (body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-")

    if (!name || !slug) {
      return NextResponse.json({ success: false, error: "name and slug are required" }, { status: 400 })
    }

    // Check slug uniqueness
    const existing = dbGet(`SELECT id FROM feed_categories WHERE slug = ?`, [slug])
    if (existing) {
      return NextResponse.json({ success: false, error: "A category with that slug already exists" }, { status: 409 })
    }

    const { lastId } = dbRun(
      `INSERT INTO feed_categories (name, slug) VALUES (?, ?)`,
      [name, slug]
    )

    const created = dbGet(`SELECT id, name, slug, created_at FROM feed_categories WHERE id = ?`, [lastId])
    return NextResponse.json({ success: true, ...(created as object) }, { status: 201 })
  } catch (error) {
    console.error("POST /api/feeds/categories error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create category" },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/feeds/categories
 * Body: { id: number, name: string, slug: string }
 * Updates an existing feed category.
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
    const name = (body.name ?? "").trim()
    const slug = (body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-")

    if (!id || !name || !slug) {
      return NextResponse.json({ success: false, error: "id, name and slug are required" }, { status: 400 })
    }

    // Check target exists
    const existing = dbGet(`SELECT id FROM feed_categories WHERE id = ?`, [id])
    if (!existing) {
      return NextResponse.json({ success: false, error: "Category not found" }, { status: 404 })
    }

    // Check slug conflict (other rows)
    const slugConflict = dbGet(
      `SELECT id FROM feed_categories WHERE slug = ? AND id != ?`,
      [slug, id]
    )
    if (slugConflict) {
      return NextResponse.json({ success: false, error: "Slug already used by another category" }, { status: 409 })
    }

    dbRun(
      `UPDATE feed_categories SET name = ?, slug = ?, updated_at = datetime('now') WHERE id = ?`,
      [name, slug, id]
    )

    const updated = dbGet(`SELECT id, name, slug, updated_at FROM feed_categories WHERE id = ?`, [id])
    return NextResponse.json({ success: true, category: updated })
  } catch (error) {
    console.error("PUT /api/feeds/categories error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update category" },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/feeds/categories?id=N
 * Deletes a category and (via ON DELETE CASCADE) all its sources.
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

    const existing = dbGet(`SELECT id FROM feed_categories WHERE id = ?`, [id])
    if (!existing) {
      return NextResponse.json({ success: false, error: "Category not found" }, { status: 404 })
    }

    const { changes } = dbRun(`DELETE FROM feed_categories WHERE id = ?`, [id])
    return NextResponse.json({ success: true, deleted: changes })
  } catch (error) {
    console.error("DELETE /api/feeds/categories error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete category" },
      { status: 500 }
    )
  }
}
