import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"
import { settingsManager } from "@/lib/settings"

/**
 * GET /api/settings/upload
 * Get upload-specific settings (convenience endpoint)
 */
export async function GET(request: NextRequest) {
  // Validate authentication
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  try {
    const uploadSettings = await settingsManager.getUploadSettings()

    // app/settings/page.tsx reads these as camelCase (maxFileSize,
    // apiConcurrency, tempCleanupHours) — getUploadSettings() itself returns
    // snake_case (it's also used directly elsewhere), so map here rather
    // than change that shape underneath other callers.
    return NextResponse.json({
      success:         true,
      maxFileSize:     uploadSettings.max_file_size,
      apiConcurrency:  uploadSettings.api_concurrency,
      tempCleanupHours: uploadSettings.temp_cleanup_hours,
    })
  } catch (error) {
    console.error("Error getting upload settings:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get upload settings",
      },
      { status: 500 }
    )
  }
}

