/**
 * Pre-flight audit for the destructive tier purges (scripts/purge-existing-t3.sh,
 * scripts/purge-existing-low-tier.sh).
 *
 * Both purges pick rows by the STORED country_tier / tld / email_domain columns, which are a SQL
 * copy of the importer's rules (lib/country-tiers.ts). The copy has drifted: on 2026-10-01 1,919,919
 * rows of ulp.credentials carried country_tier = 'T3' and the importer's own classifyTier() called
 * none of them T3 -- the SQL treats a login with no '@' as if it were an email domain. A purge on
 * that label would have deleted mainstream sign-ins the importer accepts.
 *
 * So no row is deleted on its stored label alone: every candidate is replayed through the importer's
 * own decision, shouldDropAtIngest(), and a single row the importer would have kept blocks the purge.
 */
import { classifyTier } from '@/lib/country-tiers'
import { shouldDropAtIngest, type IngestDropPolicy } from '@/lib/ingest-filter'

export interface CandidateRow {
  email: string
  url: string
}

export interface PurgeAuditSummary {
  checked: number
  /** Candidate rows the importer would NOT have dropped. */
  disagree: number
  /** The audit stopped at maxDisagree instead of reading every candidate. */
  stoppedEarly: boolean
  /** Of the disagreeing rows, those whose login has no '@' (the failure found on 2026-10-01). */
  noEmailDomain: number
  /** The importer's tier for the disagreeing rows ('' is reported as "untiered"). */
  byIngestTier: Record<string, number>
}

/** Any disagreement blocks a purge, so there is no reason to read past this many. */
const DEFAULT_MAX_DISAGREE = 1000

export class PurgeAudit {
  private checked = 0
  private disagree = 0
  private noEmailDomain = 0
  private readonly byIngestTier: Record<string, number> = {}

  constructor(
    private readonly policy: IngestDropPolicy,
    private readonly maxDisagree = DEFAULT_MAX_DISAGREE,
  ) {}

  add(row: CandidateRow): void {
    this.checked++
    // `domain` only matters to the noise rule, which neither purge uses.
    if (shouldDropAtIngest(row.email, row.url, '', this.policy)) return
    this.disagree++
    if (!row.email.includes('@')) this.noEmailDomain++
    const tier = classifyTier(row.email, row.url) || 'untiered'
    this.byIngestTier[tier] = (this.byIngestTier[tier] ?? 0) + 1
  }

  get done(): boolean {
    return this.disagree >= this.maxDisagree
  }

  summary(): PurgeAuditSummary {
    return {
      checked: this.checked,
      disagree: this.disagree,
      stoppedEarly: this.done,
      noEmailDomain: this.noEmailDomain,
      byIngestTier: { ...this.byIngestTier },
    }
  }
}

export function auditPurgeCandidates(
  rows: Iterable<CandidateRow>,
  policy: IngestDropPolicy,
  opts: { maxDisagree?: number } = {},
): PurgeAuditSummary {
  const audit = new PurgeAudit(policy, opts.maxDisagree)
  for (const row of rows) {
    audit.add(row)
    if (audit.done) break
  }
  return audit.summary()
}

const TSV_ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', '0': '\0', b: '\b', f: '\f', "'": "'", '\\': '\\' }

function unescapeTsv(field: string): string {
  return field.replace(/\\([tnr0bf'\\])/g, (_, c: string) => TSV_ESCAPES[c])
}

/** One line of `SELECT email, url ... FORMAT TSV`. */
export function parseCandidateLine(line: string): CandidateRow {
  const tab = line.indexOf('\t')
  if (tab === -1) return { email: unescapeTsv(line), url: '' }
  return { email: unescapeTsv(line.slice(0, tab)), url: unescapeTsv(line.slice(tab + 1)) }
}

/** Counts only, never row content. The last line is what the purge scripts parse. */
export function formatAuditReport(s: PurgeAuditSummary): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const lines: string[] = []
  if (s.checked === 0) {
    lines.push('Label audit: no candidate rows.')
  } else if (s.disagree === 0) {
    lines.push(`Label audit: ${n(s.checked)} candidate rows checked; the importer would have dropped every one.`)
  } else {
    const first = s.stoppedEarly ? ` (stopped at the first ${n(s.disagree)})` : ''
    lines.push(`Label audit: ${n(s.disagree)} of ${n(s.checked)} candidate rows checked would NOT have been dropped by the importer${first}.`)
    const tiers = Object.entries(s.byIngestTier)
      .sort((a, b) => b[1] - a[1])
      .map(([tier, count]) => `${tier} ${n(count)}`)
      .join(', ')
    lines.push(`  importer verdict for those rows: ${tiers}`)
    lines.push(`  of which the login has no "@": ${n(s.noEmailDomain)}`)
  }
  lines.push(`audit-result: checked=${s.checked} disagree=${s.disagree} stopped_early=${s.stoppedEarly ? 1 : 0}`)
  return `${lines.join('\n')}\n`
}
