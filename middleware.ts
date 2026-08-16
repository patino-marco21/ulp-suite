import { NextRequest, NextResponse } from "next/server"
import { validateRequest } from "@/lib/auth"

const PUBLIC_PATHS = [
  "/login",
  "/check",       // self-service email check portal (unauthenticated)
  "/api/check",   // self-service check API (rate-limited, no credentials exposed)
  "/api/auth/login",
  "/api/auth/verify-totp",
  "/api/auth/check-users",
  "/api/auth/register-first-user",
  // Logout must work even with an expired/invalid/missing token, so a stale
  // cookie can always be cleared — the route itself only clears whatever
  // cookie the caller's browser presents, so it needs no auth check.
  "/api/auth/logout",
  "/api/v1", // API v1 uses API key authentication, not JWT
  "/_next",
  "/favicon.ico"
]

// SECURITY: Rate limiting for auth endpoints to prevent brute force attacks
// Simple in-memory rate limiter for middleware (Edge-compatible)
const authRateLimitMap = new Map<string, { count: number; resetTime: number }>()

function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  return forwarded?.split(',')[0]?.trim() || realIp || 'anonymous'
}

function checkAuthRateLimit(request: NextRequest): { allowed: boolean; remaining: number } {
  const clientIP = getClientIP(request)
  const now = Date.now()
  const windowMs = 15 * 60 * 1000 // 15 minutes
  const maxAttempts = 10 // Max 10 login/TOTP attempts per 15 minutes
  
  // Cleanup expired entries periodically
  if (authRateLimitMap.size > 10000) {
    for (const [key, value] of authRateLimitMap.entries()) {
      if (now > value.resetTime) {
        authRateLimitMap.delete(key)
      }
    }
  }
  
  const current = authRateLimitMap.get(clientIP)
  
  if (!current || now > current.resetTime) {
    authRateLimitMap.set(clientIP, { count: 1, resetTime: now + windowMs })
    return { allowed: true, remaining: maxAttempts - 1 }
  }
  
  if (current.count >= maxAttempts) {
    return { allowed: false, remaining: 0 }
  }
  
  current.count++
  return { allowed: true, remaining: maxAttempts - current.count }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // SECURITY: Rate limit auth endpoints to prevent brute force attacks
  if (pathname === '/api/auth/login' || pathname === '/api/auth/verify-totp') {
    const rateLimit = checkAuthRateLimit(request)
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many login attempts. Please try again in 15 minutes." },
        { 
          status: 429,
          headers: {
            'Retry-After': '900', // 15 minutes in seconds
            'X-RateLimit-Remaining': '0'
          }
        }
      )
    }
  }

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next()
  }

  // Allow static files
  if (pathname.match(/\.(png|svg|jpg|jpeg|ico|css|js)$/)) {
    return NextResponse.next()
  }

  // Validate JWT token
  const user = await validateRequest(request)
  if (!user) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("redirect", pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Add user info to request context for API routes (internal use only)
  const response = NextResponse.next()
  // SECURITY: User identity headers removed from response to prevent information leakage
  // User context is available via validateRequest() in API routes instead

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes — each one enforces its own auth: validateRequest()
     *   for JWT-based routes, withApiKeyAuth() for /api/v1/*, or an explicit
     *   PUBLIC_PATHS entry above for the intentionally-open ones. Excluded
     *   here so Next.js never has a reason to clone API request bodies into
     *   memory at the middleware layer — it does that unconditionally for
     *   any matched non-GET/HEAD request, regardless of whether middleware()
     *   itself reads the body. See next.config.mjs history for the incident
     *   this caused with large uploads.)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
    // Re-included despite being under /api: the brute-force rate limiter
    // above (checkAuthRateLimit) only runs inside this middleware function,
    // so these two must still be matched or rate limiting silently stops.
    // Their bodies are tiny (email+password / a TOTP code) — safe to clone.
    '/api/auth/login',
    '/api/auth/verify-totp',
  ],
};