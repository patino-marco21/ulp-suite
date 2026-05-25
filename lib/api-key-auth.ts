import { NextRequest, NextResponse } from 'next/server'
import { dbQuery, dbRun, dbGet } from '@/lib/sqlite'

const API_KEY_PREFIX = 'bv_'
const API_KEY_LENGTH = 32

export type ApiKeyRole = 'admin' | 'analyst'

export interface ApiKeyPayload {
  keyId: string
  userId: string
  userName: string
  role: ApiKeyRole
  name: string
  rateLimit: number
  rateLimitWindow: number
}

export interface ApiKeyRecord {
  id: number
  user_id: number
  key_prefix: string
  key_hash: string
  name: string
  role: ApiKeyRole
  rate_limit: number
  rate_limit_window: number
  is_active: number
  expires_at: string | null
  last_used_at: string | null
  created_at: string
  updated_at: string
  user_name?: string
  user_email?: string
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
  limit: number
}

// In-memory rate limiting (per-process; sufficient for single-instance self-hosted)
const rateLimitStore = new Map<string, { count: number; windowStart: number }>()

function generateSecureRandom(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const array = new Uint8Array(length)
  globalThis.crypto.getRandomValues(array)
  return Array.from(array, (b) => chars[b % chars.length]).join('')
}

async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey)
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateApiKey(): Promise<{ apiKey: string; keyPrefix: string; keyHash: string }> {
  const randomPart = generateSecureRandom(API_KEY_LENGTH)
  const apiKey = `${API_KEY_PREFIX}${randomPart}`
  const keyPrefix = apiKey.substring(0, 10)
  const keyHash = await hashApiKey(apiKey)
  return { apiKey, keyPrefix, keyHash }
}

export async function createApiKey(params: {
  userId: number
  name: string
  role: ApiKeyRole
  rateLimit?: number
  rateLimitWindow?: number
  expiresAt?: string | null
}): Promise<{ apiKey: string; record: ApiKeyRecord }> {
  const { apiKey, keyPrefix, keyHash } = await generateApiKey()
  const rateLimit = params.rateLimit || 100
  const rateLimitWindow = params.rateLimitWindow || 60

  const { lastId } = dbRun(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, name, role, rate_limit, rate_limit_window, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [params.userId, keyPrefix, keyHash, params.name, params.role, rateLimit, rateLimitWindow, params.expiresAt || null]
  )

  const record = dbGet(
    `SELECT ak.*, u.name as user_name, u.email as user_email
     FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.id = ?`,
    [lastId]
  ) as ApiKeyRecord

  return { apiKey, record }
}

export function checkRateLimit(payload: ApiKeyPayload): RateLimitResult {
  const key = `ratelimit:${payload.keyId}`
  const now = Math.floor(Date.now() / 1000)
  const existing = rateLimitStore.get(key)

  if (!existing || now - existing.windowStart >= payload.rateLimitWindow) {
    rateLimitStore.set(key, { count: 1, windowStart: now })
    return { allowed: true, remaining: payload.rateLimit - 1, resetAt: now + payload.rateLimitWindow, limit: payload.rateLimit }
  }

  if (existing.count >= payload.rateLimit) {
    return { allowed: false, remaining: 0, resetAt: existing.windowStart + payload.rateLimitWindow, limit: payload.rateLimit }
  }

  existing.count++
  return { allowed: true, remaining: payload.rateLimit - existing.count, resetAt: existing.windowStart + payload.rateLimitWindow, limit: payload.rateLimit }
}

export async function validateApiKey(request: NextRequest): Promise<ApiKeyPayload | null> {
  const apiKey = request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace('Bearer ', '')
  if (!apiKey || !apiKey.startsWith(API_KEY_PREFIX)) return null

  const keyHash = await hashApiKey(apiKey)

  const row = dbGet(
    `SELECT ak.*, u.name as user_name, u.email as user_email
     FROM api_keys ak JOIN users u ON ak.user_id = u.id
     WHERE ak.key_hash = ? AND ak.is_active = 1
       AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))`,
    [keyHash]
  ) as ApiKeyRecord | undefined

  if (!row) return null

  // Fire-and-forget last_used update
  try { dbRun('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?', [row.id]) } catch { /**/ }

  return {
    keyId: String(row.id),
    userId: String(row.user_id),
    userName: row.user_name || '',
    role: row.role,
    name: row.name,
    rateLimit: row.rate_limit,
    rateLimitWindow: row.rate_limit_window,
  }
}

// Returns { success, apiKey, rateLimit } or { success: false, error, status }
export async function withApiKeyAuth(
  request: NextRequest,
  allowedRoles?: ApiKeyRole[]
): Promise<
  | { success: true; apiKey: ApiKeyPayload; rateLimit: RateLimitResult }
  | { success: false; error: string; status: number }
> {
  const payload = await validateApiKey(request)
  if (!payload) return { success: false, error: 'Invalid or missing API key', status: 401 }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(payload.role)) {
    return { success: false, error: 'Insufficient permissions', status: 403 }
  }

  const rateLimit = checkRateLimit(payload)
  if (!rateLimit.allowed) return { success: false, error: 'Rate limit exceeded', status: 429 }

  return { success: true, apiKey: payload, rateLimit }
}

export function addRateLimitHeaders(response: NextResponse, rateLimit: RateLimitResult): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(rateLimit.limit))
  response.headers.set('X-RateLimit-Remaining', String(Math.max(0, rateLimit.remaining)))
  response.headers.set('X-RateLimit-Reset', String(rateLimit.resetAt))
  return response
}

export async function logApiRequest(
  apiKey: ApiKeyPayload,
  request: NextRequest,
  endpoint: string
): Promise<void> {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
      || request.headers.get('x-real-ip') || null
    const ua = (request.headers.get('user-agent') || '').substring(0, 500) || null
    dbRun(
      `INSERT INTO api_request_logs (api_key_id, endpoint, method, status_code, ip_address, user_agent)
       VALUES (?, ?, ?, 200, ?, ?)`,
      [apiKey.keyId, endpoint, request.method, ip, ua]
    )
  } catch { /**/ }
}

export async function getApiKeysByUser(userId: number): Promise<Omit<ApiKeyRecord, 'key_hash'>[]> {
  return dbQuery(
    `SELECT id, user_id, key_prefix, name, role, rate_limit, rate_limit_window,
            is_active, expires_at, last_used_at, created_at, updated_at
     FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  ) as Omit<ApiKeyRecord, 'key_hash'>[]
}

export async function getAllApiKeys(): Promise<Omit<ApiKeyRecord, 'key_hash'>[]> {
  return dbQuery(
    `SELECT ak.id, ak.user_id, ak.key_prefix, ak.name, ak.role, ak.rate_limit,
            ak.rate_limit_window, ak.is_active, ak.expires_at, ak.last_used_at,
            ak.created_at, ak.updated_at, u.name as user_name, u.email as user_email
     FROM api_keys ak JOIN users u ON ak.user_id = u.id
     ORDER BY ak.created_at DESC`
  ) as Omit<ApiKeyRecord, 'key_hash'>[]
}

export async function revokeApiKey(keyId: number, userId?: number): Promise<boolean> {
  const sql = userId
    ? 'UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?'
    : 'UPDATE api_keys SET is_active = 0 WHERE id = ?'
  const params = userId ? [keyId, userId] : [keyId]
  const { changes } = dbRun(sql, params)
  return changes > 0
}

export async function deleteApiKey(keyId: number, userId?: number): Promise<boolean> {
  const sql = userId ? 'DELETE FROM api_keys WHERE id = ? AND user_id = ?' : 'DELETE FROM api_keys WHERE id = ?'
  const params = userId ? [keyId, userId] : [keyId]
  const { changes } = dbRun(sql, params)
  return changes > 0
}
