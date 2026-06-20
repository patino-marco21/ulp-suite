/**
 * Ingest-time filter — drops low-value / junk rows BEFORE they are inserted.
 *
 * A parsed credential is checked against the policy and, if it matches, never
 * reaches ulp.credentials — so it costs no storage, no dedup, no index, no
 * materialized-column compute, and no future query compute. (The line still has
 * to be parsed first: you can't know a row's tier/host without reading its
 * email/URL. Parsing is the cheap part; everything downstream is what this saves.)
 *
 * OFF BY DEFAULT and non-destructive to existing data — it only affects NEW
 * ingests, and only when configured. Enabling it permanently discards matching
 * rows at import time (re-import the source to recover them).
 *
 * Knobs (env), evaluated noise-first, then hard tiers, keep overrides, and soft drops:
 *   INGEST_FILTER_HARD_DROP_TIERS - non-overridable tiers rejected before keep
 *                                   suffixes, e.g. "T3".
 *   INGEST_FILTER_DROP_NOISE     — "true"/"1" to drop junk URLs at ingest, reusing
 *                                  the Declutter isNoiseUrl logic (IP / :port / .php /
 *                                  localhost / single-label host / non-web scheme).
 *                                  Dropped regardless of country — junk is junk.
 *   INGEST_FILTER_KEEP_SUFFIXES  — email-suffixes / URL TLDs to ALWAYS keep, even if
 *                                  their tier is dropped (keep T2/T3 wealthy countries
 *                                  — Ireland .ie, UAE .ae, Saudi .sa, …).
 *   INGEST_FILTER_DROP_TIERS     — whole tiers to drop, e.g. "T2,T3". Untiered ('') is
 *                                  NEVER tier-dropped (most high-value users are on
 *                                  generic webmail @gmail/.com and untiered).
 *   INGEST_FILTER_DROP_SUFFIXES  — extra email-suffixes / URL TLDs to drop outright.
 *
 * Recommended policy (see .env.example):
 *   HARD_DROP_TIERS=T3 and DROP_NOISE=true (T1, T2, and untiered remain)
 */
import { classifyTier, emailDomainOf, urlTldOf } from '@/lib/country-tiers'
import { isNoiseUrl } from '@/lib/ulp-noise'

export interface SuffixSet {
  /** Email-domain suffixes (normalized with a leading '.'). */
  suffixes: string[]
  /** URL TLDs (the suffixes without the leading dot). */
  tlds: Set<string>
}

export interface IngestDropPolicy {
  /** Non-overridable tier drops, evaluated before keep suffixes. */
  hardTiers: Set<string>
  /** Whole tiers to drop (T1/T2/T3). */
  tiers: Set<string>
  /** Drop these email suffixes / URL TLDs. */
  drop: SuffixSet
  /** Keep these even if their tier/suffix would otherwise be dropped (wins over tier). */
  keep: SuffixSet
  /** Drop junk URLs (isNoiseUrl) at ingest — independent of country. */
  dropNoise: boolean
}

const VALID = new Set(['T1', 'T2', 'T3'])

function parseTierSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',').map(t => t.trim().toUpperCase()).filter(t => VALID.has(t)),
  )
}

function parseSuffixSet(raw: string | undefined): SuffixSet {
  const suffixes = (raw ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .map(s => (s.startsWith('.') ? s : `.${s}`))
  return { suffixes, tlds: new Set(suffixes.map(s => s.slice(1))) }
}

export function parseIngestPolicy(env: NodeJS.ProcessEnv = process.env): IngestDropPolicy {
  const dropNoise = ['1', 'true', 'yes', 'on'].includes(
    (env.INGEST_FILTER_DROP_NOISE ?? '').trim().toLowerCase(),
  )
  return {
    hardTiers: parseTierSet(env.INGEST_FILTER_HARD_DROP_TIERS),
    tiers: parseTierSet(env.INGEST_FILTER_DROP_TIERS),
    drop: parseSuffixSet(env.INGEST_FILTER_DROP_SUFFIXES),
    keep: parseSuffixSet(env.INGEST_FILTER_KEEP_SUFFIXES),
    dropNoise,
  }
}

/** True when the policy would drop at least something (lets callers skip the work). */
export function policyActive(p: IngestDropPolicy): boolean {
  return p.hardTiers.size > 0 || p.tiers.size > 0 || p.drop.suffixes.length > 0 || p.dropNoise
}

/** Does this credential's email-suffix or URL-TLD fall in the given set? */
function matchesSuffixSet(email: string, url: string, set: SuffixSet): boolean {
  if (set.suffixes.length === 0) return false
  const ed = emailDomainOf(email)
  if (set.suffixes.some(suf => ed.endsWith(suf))) return true
  const tld = urlTldOf(url)
  return tld !== '' && set.tlds.has(tld)
}

/** Whether this credential should be dropped at ingest under the policy. */
export function shouldDropAtIngest(email: string, url: string, domain: string, p: IngestDropPolicy): boolean {
  // Junk URL → dropped regardless of country (junk is junk). Checked BEFORE the
  // keep-override so a kept country can't rescue a chrome://, IP-host, .php, etc. row.
  if (p.dropNoise && isNoiseUrl(url, domain)) return true

  const tier = classifyTier(email, url)
  // Hard drops are policy invariants: keep suffixes cannot rescue these tiers.
  if (tier !== '' && p.hardTiers.has(tier)) return true

  // Keep-override wins over tier: an explicitly-kept country is never tier-dropped
  // (this is how T2/T3 wealthy countries survive a DROP_TIERS).
  if (matchesSuffixSet(email, url, p.keep)) return false

  if (p.tiers.size > 0) {
    // Untiered ('') is intentionally never tier-dropped.
    if (tier !== '' && p.tiers.has(tier)) return true
  }
  if (matchesSuffixSet(email, url, p.drop)) return true
  return false
}
