import { createClient, type ClickHouseClient } from '@clickhouse/client'

// ClickHouse connection configuration
// ALL credentials MUST come from .env.local or .env - NO HARDCODED VALUES!
// If not found in .env.local or .env, will throw error (no fallback)

/**
 * Validate required environment variables
 * THROWS ERROR if not found (no fallback)
 */
function validateEnvVars() {
  // CLICKHOUSE_DATABASE can come from .env as CLICKHOUSE_DB (docker-compose uses CLICKHOUSE_DB; app expects CLICKHOUSE_DATABASE)
  const database = process.env.CLICKHOUSE_DATABASE || process.env.CLICKHOUSE_DB
  const requiredEnvVars = {
    CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST,
    CLICKHOUSE_USER: process.env.CLICKHOUSE_USER,
    CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD,
    CLICKHOUSE_DATABASE: database,
  }

  // Check if all required variables are set
  // Note: password is intentionally allowed to be empty (ClickHouse default user has no password)
  const missingVars = Object.entries(requiredEnvVars)
    .filter(([key, value]) => key !== 'CLICKHOUSE_PASSWORD' && (value === undefined || value === null || value === ''))
    .map(([key]) => key)

  if (missingVars.length > 0) {
    throw new Error(
      `❌ Missing required ClickHouse environment variables: ${missingVars.join(', ')}\n` +
      `   Please add them to .env.local or .env file:\n` +
      `   CLICKHOUSE_HOST=...\n` +
      `   CLICKHOUSE_USER=...\n` +
      `   CLICKHOUSE_PASSWORD=...\n` +
      `   CLICKHOUSE_DATABASE=...`
    )
  }

  return {
    host: requiredEnvVars.CLICKHOUSE_HOST!,
    username: requiredEnvVars.CLICKHOUSE_USER!,
    password: requiredEnvVars.CLICKHOUSE_PASSWORD ?? '',
    database: requiredEnvVars.CLICKHOUSE_DATABASE!,
  }
}

/**
 * Singleton Pattern to prevent multiple instances during hot-reload in development
 * 
 * In Next.js development environment, Hot Reload often creates new instances
 * every time a file is saved, without closing old connections. This can cause
 * "Too many connections" error in ClickHouse.
 * 
 * With Singleton pattern, we reuse existing connections.
 */
const globalForClickHouse = global as unknown as {
  clickhouse: ClickHouseClient | undefined
}

/**
 * Get or create ClickHouse client instance (Singleton)
 * Lazy initialization - only creates client when needed (not at module load)
 */
function getClickHouseClient(): ClickHouseClient {
  // If already exists in global (development hot-reload), reuse
  if (globalForClickHouse.clickhouse) {
    return globalForClickHouse.clickhouse
  }

  // Validate environment variables first (THROWS ERROR if not found)
  const chConfig = validateEnvVars()

  // Build ClickHouse URL (new format - replaces deprecated 'host' option)
  // Format: http://username:password@host:port/database
  // CLICKHOUSE_HOST should already include protocol and port (e.g., http://clickhouse:8123)
  let clickhouseUrl: string
  if (chConfig.host.includes('://')) {
    // Extract host:port from URL (e.g., http://clickhouse:8123 -> clickhouse:8123)
    const urlMatch = chConfig.host.match(/^https?:\/\/(.+)$/)
    const hostPort = urlMatch ? urlMatch[1] : chConfig.host
    clickhouseUrl = `http://${encodeURIComponent(chConfig.username)}:${encodeURIComponent(chConfig.password)}@${hostPort}/${chConfig.database}`
  } else {
    // If host doesn't include protocol, assume http://
    clickhouseUrl = `http://${encodeURIComponent(chConfig.username)}:${encodeURIComponent(chConfig.password)}@${chConfig.host}/${chConfig.database}`
  }

  // Create new client using URL (new recommended way)
  const client = createClient({
    url: clickhouseUrl,

    // ── HTTP-level timeout ──────────────────────────────────────────────────
    // 1 hour: large batch inserts (100 M rows) can legitimately take minutes.
    // SELECT queries are capped separately via max_execution_time below.
    request_timeout: 3_600_000,

    // ── Keep-alive: reuse TCP connections across requests ──────────────────
    keep_alive: {
      enabled: true,
      idle_socket_ttl: 9_000,  // recycle before ClickHouse server-side 10s keepalive timeout
    },

    // ── Server-side settings applied to every request ──────────────────────
    clickhouse_settings: {
      // Cap SELECT queries at 60 s — fast enough for any indexed search;
      // prevents runaway LIKE/regex fallbacks from blocking the server.
      // INSERT/DDL are not affected by this setting.
      max_execution_time: 60,

      // Query result cache: ClickHouse 23.1+ stores SELECT results in memory.
      // Identical repeated queries (same SQL + same params) return instantly.
      // 30 s TTL balances freshness (new imports visible quickly) vs. server load.
      use_query_cache: 1,
      query_cache_ttl: 30,

      // Ask ClickHouse to ZSTD-compress HTTP responses.
      // The client decompresses automatically (see compression.response below).
      enable_http_compression: 1,
    },

    // ── Transport-level compression ────────────────────────────────────────
    compression: {
      // Compress INSERT request bodies → 3–5× less network traffic for bulk uploads
      request: true,
      // Decompress compressed responses from ClickHouse
      response: true,
    },
  })

  // Always store in global so the same client is reused across requests in the
  // same process (important in production where the module isn't reloaded per request).
  globalForClickHouse.clickhouse = client

  return client
}

// Lazy getter for client - only creates connection when actually needed
// This prevents build-time errors when environment variables aren't available
export function getClient(): ClickHouseClient {
  return getClickHouseClient()
}

// Export client getter (for backward compatibility)
// Use getClient() instead of direct client access
export const client = new Proxy({} as ClickHouseClient, {
  get(_target, prop) {
    return getClickHouseClient()[prop as keyof ClickHouseClient]
  }
})

/**
 * Execute query with format similar to MySQL executeQuery
 * Supports named parameters (ClickHouse format)
 * 
 * ClickHouse uses named parameters with type annotation:
 * - {paramName:Type} in query
 * - { paramName: value } in params object
 * 
 * @param query SQL query with named parameters: {paramName:Type}
 * @param params Object with parameter values: { paramName: value }
 * @param signal Optional AbortSignal to cancel query (if driver supports it)
 * @returns Array of results (similar to MySQL format)
 * 
 * @example
 * ```typescript
 * const result = await executeQuery(
 *   "SELECT * FROM credentials WHERE device_id = {deviceId:String} AND domain = {domain:String}",
 *   { deviceId: "123", domain: "example.com" }
 * )
 * ```
 */
export async function executeQuery(
  query: string, 
  params: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<any[]> {
  // Check abort BEFORE any async operations to avoid overhead
  if (signal?.aborted) {
    const error = new Error("Query aborted by client")
    error.name = "AbortError"
    throw error
  }

  try {
    const chClient = getClickHouseClient()
    
    // Build query options
    const queryOptions: any = {
      query: query,
      format: 'JSONEachRow', // Important so output is Array of Objects similar to MySQL
      query_params: params,  // ClickHouse uses named parameters
    }
    
    // Pass signal if provided and not already aborted
    // Note: @clickhouse/client v1.x uses abort_signal (underscore) property
    // Verified: @clickhouse/client v1.14.0 uses abort_signal
    // 
    // IMPORTANT: Only pass signal if not already aborted to avoid overhead
    if (signal && !signal.aborted) {
      // Use abort_signal (underscore) - correct property name for @clickhouse/client v1.x
      queryOptions.abort_signal = signal
    }
    
    // Check abort again before expensive query operation
    if (signal?.aborted) {
      const error = new Error("Query aborted by client")
      error.name = "AbortError"
      throw error
    }
    
    const resultSet = await chClient.query(queryOptions)
    
    // Check if signal was aborted during query execution
    if (signal?.aborted) {
      const error = new Error("Query aborted by client")
      error.name = "AbortError"
      throw error
    }
    
    const data = await resultSet.json()
    
    // Final check before returning
    if (signal?.aborted) {
      const error = new Error("Query aborted by client")
      error.name = "AbortError"
      throw error
    }
    
    return (data as unknown) as any[]
  } catch (error) {
    // 🛑 KEY: Detect abort errors more aggressively
    // Check name, code, and message to catch all variants of abort errors
    const isAbort = 
      error instanceof Error && (
        error.name === 'AbortError' || 
        (error as any).code === 'ECONNRESET' || 
        error.message?.toLowerCase().includes('aborted') ||
        error.message?.toLowerCase().includes('abort')
      )

    if (isAbort) {
      // Re-throw without logging - this is normal behavior
      // Abort request is valid user behavior, not a system error
      throw error
    }
    
    // Only log errors that are real server issues
    console.error("❌ ClickHouse query error:", error)
    console.error("❌ Error type:", typeof error)
    console.error("❌ Error message:", error instanceof Error ? error.message : String(error))
    console.error("❌ Error code:", (error as any)?.code)
    console.error("❌ Error type (ClickHouse):", (error as any)?.type)
    // Log short query snippet for debugging (don't log full if too long)
    console.error("📝 Query Snippet:", query.substring(0, 200) + (query.length > 200 ? "..." : ""))
    // SECURITY: do not log raw params — they may contain emails, passwords, or
    // other credential fragments.  Log only the param keys for debugging.
    if (params && typeof params === 'object') {
      console.error("📦 Param keys:", Object.keys(params).join(', '))
    }
    
    // Re-throw error for handling in caller
    throw error
  }
}

/**
 * Test ClickHouse connection
 * Useful for health check or initialization verification
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await executeQuery("SELECT 1 as test")
    return result.length > 0 && result[0].test === 1
  } catch (error) {
    console.error("❌ ClickHouse connection test failed:", error)
    return false
  }
}

/**
 * Close ClickHouse connection (for cleanup)
 * Usually not needed as client handles connection pooling
 */
export async function closeConnection() {
  try {
    const chClient = getClickHouseClient()
    await chClient.close()
    // Clear global reference
    if (globalForClickHouse.clickhouse) {
      globalForClickHouse.clickhouse = undefined
    }
    console.warn("✅ ClickHouse connection closed")
  } catch (error) {
    console.error("❌ Error closing ClickHouse connection:", error)
  }
}


