import { type NextRequest } from 'next/server'
import { rateLimitKey } from '@/lib/client-ip'

/**
 * Shared in-memory rate limiter.
 *
 * Used by API routes that need to throttle by IP. Single-process only
 * (correct for self-hosted Next.js; reset on restart is acceptable).
 */

export interface LimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number
}

export function checkLimit(
  map:      Map<string, { count: number; resetAt: number }>,
  key:      string,
  maxCount: number,
  windowMs: number,
): LimitResult {
  const now = Date.now()

  if (map.size > 5_000) {
    for (const [k, v] of map) {
      if (now > v.resetAt) map.delete(k)
    }
  }

  const entry = map.get(key)

  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: maxCount - 1, resetAt: now + windowMs }
  }

  if (entry.count >= maxCount) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { allowed: true, remaining: maxCount - entry.count, resetAt: entry.resetAt }
}

/**
 * What to key a limiter on for this request: the caller's address when a trusted reverse proxy vouches for it
 * (TRUST_PROXY_HOPS, see lib/client-ip.ts), otherwise one shared key. The forwarded-address header is whatever
 * the caller wrote unless a proxy appended to it, so keying on it lets a caller pick a fresh bucket per request.
 */
export function getClientIP(req: NextRequest): string {
  return rateLimitKey(req.headers)
}

