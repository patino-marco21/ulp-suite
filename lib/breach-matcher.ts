/**
 * Breach correlation — maps source filenames to known data breaches.
 *
 * Matching pipeline (first hit wins):
 *   1. SQLite source_breach_map cache (manual overrides always win)
 *   2. Hardcoded mega-dump / compilation patterns (case-insensitive substring)
 *   3. Fuzzy Jaccard word-overlap against all breach records in SQLite
 *
 * Results are cached in source_breach_map so each filename is only resolved once.
 */

import { dbGet, dbQuery, dbRun } from './sqlite'

export interface BreachMatch {
  breach_name: string
  title: string
  confidence: number
  method: 'filename_heuristic' | 'fuzzy' | 'manual'
}

export interface BreachRecord {
  id: number
  breach_name: string
  title: string
  domain: string
  breach_date: string
  pwn_count: number
  description: string
  logo_path: string
  data_classes: string[]
  is_verified: boolean
  is_fabricated: boolean
  is_sensitive: boolean
  is_spam_list: boolean
  is_malware: boolean
  is_stealer_log: boolean
  is_mega_dump: boolean
  source_file_patterns: string[]
  created_at: string
  updated_at: string
}

// ─── Mega-dump / compilation catalogue ───────────────────────────────────────
// These are aggregated datasets that either predate HIBP or aren't in it.
// Checked before fuzzy matching so "rockyou.txt" doesn't match "RockYou2009" via
// a lucky word overlap — we want deterministic matching for known compilations.

const MEGA_DUMPS: Array<{
  patterns: string[]
  name: string
  title: string
  pwn_count?: number
}> = [
  { patterns: ['rockyou2024'], name: 'RockYou2024', title: 'RockYou 2024', pwn_count: 10_000_000_000 },
  { patterns: ['rockyou2021'], name: 'RockYou2021', title: 'RockYou 2021', pwn_count: 8_459_060_239 },
  { patterns: ['rockyou'], name: 'RockYou2009', title: 'RockYou 2009', pwn_count: 32_603_388 },
  { patterns: ['collection1', 'collection#1', 'collection_1'], name: 'Collection1', title: 'Collection #1', pwn_count: 772_904_991 },
  { patterns: ['collection2', 'collection#2'], name: 'Collection2', title: 'Collection #2' },
  { patterns: ['collection3', 'collection#3'], name: 'Collection3', title: 'Collection #3' },
  { patterns: ['collection4', 'collection#4'], name: 'Collection4', title: 'Collection #4' },
  { patterns: ['collection5', 'collection#5'], name: 'Collection5', title: 'Collection #5' },
  { patterns: ['comb', 'combo_of_many', 'combolist_of_many_breaches'], name: 'COMB', title: 'Compilation of Many Breaches (COMB)', pwn_count: 3_270_000_000 },
  { patterns: ['moab', 'mother_of_all_breaches'], name: 'MOAB', title: 'Mother of All Breaches', pwn_count: 26_000_000_000 },
  { patterns: ['antipublic'], name: 'AntiPublic', title: 'AntiPublic Combo List' },
  { patterns: ['exploit.in', 'exploitin', 'exploit_in'], name: 'ExploitIn', title: 'Exploit.in', pwn_count: 593_427_119 },
  { patterns: ['pemiblanc'], name: 'Pemiblanc', title: 'Pemiblanc' },
  { patterns: ['caniphish'], name: 'CaniPhish', title: 'CaniPhish' },
]

// ─── Text normalisation ───────────────────────────────────────────────────────

function normalizeFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(txt|csv|json|zip|gz|7z|tar)$/, '') // strip extension
    .replace(/[_\-\.]/g, ' ')                         // separators → space
    .replace(/[^a-z0-9 ]/g, '')                       // drop punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Jaccard similarity on word sets (only words ≥ 3 chars to ignore stop words).
 * Score ∈ [0, 1] where 1 = identical word sets.
 */
function wordJaccard(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(w => w.length >= 3))
  const wb = new Set(b.split(' ').filter(w => w.length >= 3))
  if (wa.size === 0 && wb.size === 0) return 0
  const intersect = [...wa].filter(w => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return union > 0 ? intersect / union : 0
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function ensureBreachExists(data: {
  breach_name: string
  title: string
  pwn_count?: number
  is_mega_dump?: boolean
}): void {
  dbRun(
    `INSERT OR IGNORE INTO breaches (breach_name, title, pwn_count, is_mega_dump)
     VALUES (?, ?, ?, ?)`,
    [data.breach_name, data.title, data.pwn_count || 0, data.is_mega_dump ? 1 : 0]
  )
}

function cacheSourceMap(sourceFile: string, match: BreachMatch): void {
  dbRun(
    `INSERT OR REPLACE INTO source_breach_map
       (source_file, breach_name, confidence, match_method)
     VALUES (?, ?, ?, ?)`,
    [sourceFile, match.breach_name, match.confidence, match.method]
  )
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a source filename to a breach name.
 * Returns an empty string if no confident match is found.
 */
export function matchBreach(sourceFile: string): string {
  const match = matchBreachFull(sourceFile)
  return match?.breach_name ?? ''
}

/**
 * Resolve a source filename to a full BreachMatch (with confidence + method).
 * Returns null if no match exceeds the confidence threshold.
 */
export function matchBreachFull(sourceFile: string): BreachMatch | null {
  // 1. Check cache / manual overrides first
  const cached = dbGet(
    `SELECT breach_name, confidence, match_method FROM source_breach_map WHERE source_file = ?`,
    [sourceFile]
  ) as { breach_name: string; confidence: number; match_method: string } | undefined

  if (cached) {
    const breach = dbGet(
      `SELECT title FROM breaches WHERE breach_name = ?`,
      [cached.breach_name]
    ) as { title: string } | undefined
    return {
      breach_name: cached.breach_name,
      title: breach?.title ?? cached.breach_name,
      confidence: cached.confidence,
      method: cached.match_method as BreachMatch['method'],
    }
  }

  const norm = normalizeFilename(sourceFile)

  // 2. Hardcoded mega-dump patterns (substring check on normalized name)
  for (const dump of MEGA_DUMPS) {
    if (dump.patterns.some(p => norm.includes(p))) {
      ensureBreachExists({ ...dump, breach_name: dump.name, is_mega_dump: true })
      const m: BreachMatch = {
        breach_name: dump.name,
        title: dump.title,
        confidence: 0.92,
        method: 'filename_heuristic',
      }
      cacheSourceMap(sourceFile, m)
      return m
    }
  }

  // 3. Fuzzy match against all breach records in SQLite
  const allBreaches = dbQuery(
    `SELECT breach_name, title FROM breaches`
  ) as Array<{ breach_name: string; title: string }>

  let best: BreachMatch | null = null
  let bestScore = 0

  for (const breach of allBreaches) {
    const scoreTitle = wordJaccard(norm, normalizeFilename(breach.title))
    const scoreName = wordJaccard(norm, normalizeFilename(breach.breach_name))
    const score = Math.max(scoreTitle, scoreName)
    if (score > bestScore) {
      bestScore = score
      best = {
        breach_name: breach.breach_name,
        title: breach.title,
        confidence: score,
        method: 'fuzzy',
      }
    }
  }

  // Threshold: require at least 40% word overlap for auto-tagging
  if (best && bestScore >= 0.4) {
    cacheSourceMap(sourceFile, best)
    return best
  }

  return null
}

/**
 * Manually assign a breach name to a source file.
 * Creates a 'manual' entry in source_breach_map (highest priority).
 */
export function assignBreachToSource(sourceFile: string, breachName: string): void {
  dbRun(
    `INSERT OR REPLACE INTO source_breach_map
       (source_file, breach_name, confidence, match_method)
     VALUES (?, ?, 1.0, 'manual')`,
    [sourceFile, breachName]
  )
}

/**
 * Parse a SQLite breach row into a typed BreachRecord.
 */
export function parseBreachRow(row: Record<string, unknown>): BreachRecord {
  let data_classes: string[] = []
  let source_file_patterns: string[] = []
  try { data_classes = JSON.parse(row.data_classes as string || '[]') } catch { data_classes = [] }
  try { source_file_patterns = JSON.parse(row.source_file_patterns as string || '[]') } catch { source_file_patterns = [] }
  return {
    id: row.id as number,
    breach_name: row.breach_name as string,
    title: row.title as string,
    domain: (row.domain as string) || '',
    breach_date: (row.breach_date as string) || '',
    pwn_count: Number(row.pwn_count || 0),
    description: (row.description as string) || '',
    logo_path: (row.logo_path as string) || '',
    data_classes,
    source_file_patterns,
    is_verified: Boolean(row.is_verified),
    is_fabricated: Boolean(row.is_fabricated),
    is_sensitive: Boolean(row.is_sensitive),
    is_spam_list: Boolean(row.is_spam_list),
    is_malware: Boolean(row.is_malware),
    is_stealer_log: Boolean(row.is_stealer_log),
    is_mega_dump: Boolean(row.is_mega_dump),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
