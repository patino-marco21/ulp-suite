/**
 * Shared stats cache state.
 * Kept in a separate lib file so both the stats route and upload route
 * can import it without crossing Next.js route-file module boundaries.
 */

export interface StatsResult {
  success: true
  credentials: {
    total: number
    unique_domains: number
    unique_emails: number
    last_import: string | null
  }
  sources: {
    total: number
    total_lines: number
  }
  top_domains:      Array<{ domain: string; count: number }>
  top_passwords:    Array<{ password: string; count: number }>
  top_tlds:         Array<{ tld: string; count: number }>
  password_lengths: Array<{ bucket: string; count: number }>
  // New analytics
  password_patterns:   Array<{ mask: string; count: number }>
  country_tier_dist:   Array<{ tier: string; count: number }>
  login_type_dist:     Array<{ type: string; count: number }>
  url_scheme_dist:     Array<{ scheme: string; count: number }>
  top_email_domains:   Array<{ domain: string; count: number }>
  top_breaches:        Array<{ breach_name: string; count: number }>
  reuse_stats: {
    reused_pairs: number
    total_pairs: number
    reuse_pct: number
  }
  corporate_stats: {
    corporate: number
    consumer: number
    total_emails: number
  }
  // New analytics (gracefully absent on older cached responses)
  entropy_band_dist: Array<{ band: string; count: number }>
  import_timeline:   Array<{ day: string; count: number }>
  top_sources:       Array<{ source_file: string; count: number }>
  top_url_hosts:     Array<{ host: string; count: number }>
}

// 30 minutes — at billions-of-row scale stats queries are expensive;
// cache aggressively and bust on upload or manual refresh.
export const CACHE_TTL_MS = 30 * 60 * 1000

let _cache: { data: StatsResult; expires: number } | null = null

export function getStatsCache(): { data: StatsResult; expires: number } | null {
  return _cache
}

export function setStatsCache(data: StatsResult): void {
  _cache = { data, expires: Date.now() + CACHE_TTL_MS }
}

export function invalidateStatsCache(): void {
  _cache = null
}
