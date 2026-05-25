import { type NextRequest, NextResponse } from "next/server"
import { executeQuery } from "@/lib/clickhouse"
import { validateRequest } from "@/lib/auth"
import {
  type StatsResult,
  getStatsCache,
  setStatsCache,
  invalidateStatsCache,
} from "@/lib/stats-cache"

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const user = await validateRequest(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const bust = new URL(request.url).searchParams.has('bust')
  if (bust) invalidateStatsCache()

  const cached = getStatsCache()
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json(cached.data)
  }

  try {
    const [
      totalCount,
      credAggStats,
      sourceStats,
      topDomains,
      topPasswords,
      topTlds,
      passwordLengths,
      passwordPatterns,
      countryTierDist,
      loginTypeDist,
      urlSchemeDist,
      topEmailDomains,
      topBreaches,
      reuseStats,
      corporateStats,
      entropyBandDist,
      importTimeline,
      topSources,
      topUrlHosts,
    ] = await Promise.all([
      // ── Instant total row count from partition metadata (no data scan) ──────
      // system.parts stores per-part row counts maintained by MergeTree.
      // Summing active parts gives an exact total in microseconds vs seconds.
      executeQuery(`
        SELECT sum(rows) AS total_credentials
        FROM system.parts
        WHERE database = 'ulp' AND table = 'credentials' AND active = 1
      `),
      // ── Aggregate stats (HyperLogLog approximate distinct counts) ───────────
      // uniq() is ~5× faster than count(DISTINCT …) at the cost of <1% error.
      // Separated from total_count so it can run in parallel without blocking
      // the cheap metadata query above.
      executeQuery(`
        SELECT
          uniq(domain)     AS unique_domains,
          uniq(email)      AS unique_emails,
          max(imported_at) AS last_import
        FROM ulp.credentials
        SETTINGS max_execution_time = 60
      `),
      executeQuery(`
        SELECT count() AS total_sources, sum(line_count) AS total_lines
        FROM ulp.sources
      `),
      // domain is the first column in the primary key → GROUP BY domain is index-aligned
      executeQuery(`
        SELECT domain, count() AS count
        FROM ulp.credentials
        WHERE domain != ''
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 15
        SETTINGS max_execution_time = 30
      `),
      // Standard GROUP BY — fast for current scale (< 100 M rows).
      // At 100 B+ rows, ClickHouse will use the skip index on password and
      // the 30-second cap (max_execution_time) returns partial results rather
      // than hanging. SAMPLE BY requires schema-level SAMPLE BY clause;
      // since the table doesn't define one we use plain GROUP BY here.
      executeQuery(`
        SELECT password, count() AS count
        FROM ulp.credentials
        WHERE length(password) > 0
        GROUP BY password
        ORDER BY count DESC
        LIMIT 50
        SETTINGS max_execution_time = 30
      `),
      executeQuery(`
        SELECT tld, count() AS count
        FROM ulp.credentials
        WHERE tld != ''
        GROUP BY tld
        ORDER BY count DESC
        LIMIT 10
        SETTINGS max_execution_time = 30
      `),
      // Password length in fine-grained buckets
      executeQuery(`
        SELECT
          CASE
            WHEN password_length = 0   THEN '0 (empty)'
            WHEN password_length <= 4  THEN '1-4'
            WHEN password_length <= 6  THEN '5-6'
            WHEN password_length <= 8  THEN '7-8'
            WHEN password_length <= 10 THEN '9-10'
            WHEN password_length <= 12 THEN '11-12'
            WHEN password_length <= 16 THEN '13-16'
            WHEN password_length <= 20 THEN '17-20'
            ELSE                            '21+'
          END AS bucket,
          count() AS count
        FROM ulp.credentials
        GROUP BY bucket
        ORDER BY min(password_length)
      `),
      // password_mask is a LowCardinality column — cardinality ≤ 5; very fast GROUP BY
      executeQuery(`
        SELECT password_mask AS mask, count() AS count
        FROM ulp.credentials
        GROUP BY mask
        ORDER BY count DESC
        SETTINGS max_execution_time = 30
      `),
      // country_tier is LowCardinality (≤ ~10 values) — fast GROUP BY
      executeQuery(`
        SELECT country_tier AS tier, count() AS count
        FROM ulp.credentials
        GROUP BY tier
        ORDER BY count DESC
        SETTINGS max_execution_time = 30
      `),
      // login_type is LowCardinality (≤ 4 values) — near-instant GROUP BY
      executeQuery(`
        SELECT login_type AS type, count() AS count
        FROM ulp.credentials
        GROUP BY type
        ORDER BY count DESC
        SETTINGS max_execution_time = 30
      `),
      // url_scheme is LowCardinality (http / https / '') — near-instant GROUP BY
      executeQuery(`
        SELECT url_scheme AS scheme, count() AS count
        FROM ulp.credentials
        WHERE url_scheme != ''
        GROUP BY scheme
        ORDER BY count DESC
        SETTINGS max_execution_time = 30
      `),
      // Top email domains — unindexed but bounded by login_type = 'email' pre-filter
      executeQuery(`
        SELECT email_domain AS domain, count() AS count
        FROM ulp.credentials
        WHERE login_type = 'email' AND email_domain != ''
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 15
        SETTINGS max_execution_time = 30
      `),
      // Top breaches — breach_name cardinality is typically low (hundreds)
      executeQuery(`
        SELECT breach_name, count() AS count
        FROM ulp.credentials
        WHERE breach_name != ''
        GROUP BY breach_name
        ORDER BY count DESC
        LIMIT 15
        SETTINGS max_execution_time = 30
      `),
      // Password reuse rate — most expensive query: double GROUP BY.
      // uniq(domain) instead of count(DISTINCT domain) is ~5× faster (HyperLogLog).
      // LIMIT on inner query caps it at 5 M unique pairs — sufficient for a rate estimate.
      executeQuery(`
        SELECT
          countIf(domain_count > 1) AS reused_pairs,
          count()                   AS total_pairs
        FROM (
          SELECT email, password, uniq(domain) AS domain_count
          FROM ulp.credentials
          WHERE login_type = 'email' AND length(password) > 0
          GROUP BY email, password
          LIMIT 5000000
        )
        SETTINGS max_execution_time = 60
      `),
      // Corporate vs consumer — two countIf on a LowCardinality column → fast
      executeQuery(`
        SELECT
          countIf(is_corporate_email = 1) AS corporate,
          countIf(is_corporate_email = 0) AS consumer
        FROM ulp.credentials
        WHERE login_type = 'email'
        SETTINGS max_execution_time = 30
      `),
      // password_entropy_band is LowCardinality (5 values) → near-instant GROUP BY
      executeQuery(`
        SELECT password_entropy_band AS band, count() AS count
        FROM ulp.credentials
        WHERE length(password) > 0
        GROUP BY band
        ORDER BY count DESC
        SETTINGS max_execution_time = 30
      `).catch(() => [] as any[]),
      // Import timeline — imported_at has a minmax skip index; 90-day range is selective
      executeQuery(`
        SELECT
          toDate(imported_at) AS day,
          count()             AS count
        FROM ulp.credentials
        WHERE imported_at >= now() - INTERVAL 90 DAY
        GROUP BY day
        ORDER BY day ASC
        SETTINGS max_execution_time = 30
      `).catch(() => [] as any[]),
      // Top source files — source_file cardinality is low (hundreds of files at most)
      executeQuery(`
        SELECT source_file, count() AS count
        FROM ulp.credentials
        WHERE source_file != ''
        GROUP BY source_file
        ORDER BY count DESC
        LIMIT 20
        SETTINGS max_execution_time = 30
      `).catch(() => [] as any[]),
      // Top URL hosts — url_host has a bloom_filter skip index
      executeQuery(`
        SELECT
          if(url_host != '', url_host, domain) AS host,
          count()                               AS count
        FROM ulp.credentials
        WHERE (url_host != '' OR domain != '')
        GROUP BY host
        ORDER BY count DESC
        LIMIT 15
        SETTINGS max_execution_time = 30
      `).catch(() => [] as any[]),
    ])

    const reuseRow = (reuseStats as any[])[0] || {}
    const reusedPairs = Number(reuseRow.reused_pairs || 0)
    const totalPairs  = Number(reuseRow.total_pairs  || 1)

    const corpRow = (corporateStats as any[])[0] || {}
    const corporate = Number(corpRow.corporate || 0)
    const consumer  = Number(corpRow.consumer  || 0)

    const aggRow = (credAggStats as any[])[0] || {}

    const result: StatsResult = {
      success: true,
      credentials: {
        total:          Number((totalCount as any[])[0]?.total_credentials || 0),
        unique_domains: Number(aggRow.unique_domains || 0),
        unique_emails:  Number(aggRow.unique_emails  || 0),
        last_import:    (aggRow.last_import as string) || null,
      },
      sources: {
        total:       Number((sourceStats as any[])[0]?.total_sources || 0),
        total_lines: Number((sourceStats as any[])[0]?.total_lines   || 0),
      },
      top_domains:      (topDomains as any[]).map(r => ({ domain: String(r.domain), count: Number(r.count) })),
      top_passwords:    (topPasswords as any[]).map(r => ({ password: String(r.password), count: Number(r.count) })),
      top_tlds:         (topTlds as any[]).map(r => ({ tld: String(r.tld), count: Number(r.count) })),
      password_lengths: (passwordLengths as any[]).map(r => ({ bucket: String(r.bucket), count: Number(r.count) })),
      password_patterns:   (passwordPatterns as any[]).map(r => ({ mask: String(r.mask), count: Number(r.count) })),
      country_tier_dist:   (countryTierDist as any[]).map(r => ({ tier: String(r.tier), count: Number(r.count) })),
      login_type_dist:     (loginTypeDist as any[]).map(r => ({ type: String(r.type), count: Number(r.count) })),
      url_scheme_dist:     (urlSchemeDist as any[]).map(r => ({ scheme: String(r.scheme), count: Number(r.count) })),
      top_email_domains:   (topEmailDomains as any[]).map(r => ({ domain: String(r.domain), count: Number(r.count) })),
      top_breaches:        (topBreaches as any[]).map(r => ({ breach_name: String(r.breach_name), count: Number(r.count) })),
      reuse_stats: {
        reused_pairs: reusedPairs,
        total_pairs:  totalPairs,
        reuse_pct:    Math.round(reusedPairs / totalPairs * 1000) / 10,
      },
      corporate_stats: {
        corporate,
        consumer,
        total_emails: corporate + consumer,
      },
      entropy_band_dist: (entropyBandDist as any[]).map(r => ({ band: String(r.band), count: Number(r.count) })),
      import_timeline:   (importTimeline as any[]).map(r => ({ day: String(r.day), count: Number(r.count) })),
      top_sources:       (topSources as any[]).map(r => ({ source_file: String(r.source_file), count: Number(r.count) })),
      top_url_hosts:     (topUrlHosts as any[]).map(r => ({ host: String(r.host), count: Number(r.count) })),
    }

    setStatsCache(result)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Stats error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch stats' }, { status: 500 })
  }
}
