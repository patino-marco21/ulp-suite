import { classifyTier } from '@/lib/country-tiers'
import { parseCandidateLine } from '@/lib/purge-audit'

/**
 * Parity between the three things that can label a row with a country tier:
 *
 *   stored      the ulp.credentials.country_tier column (computed by ClickHouse when the row was inserted)
 *   expression  what the CURRENT column expression (buildCountryTierExpression) gives for the same row
 *   importer    classifyTier(email, url), the TypeScript twin the importer's hard drop uses
 *
 * The importer is the reference: it decides what is accepted. A stored label that differs is stale or wrong
 * (lib/country-tiers.ts: 1.92M rows were stored as T3 that it calls untiered, T1 or T2); an expression that
 * differs from it is a bug in the SQL. Keeps counts and shapes only, never a row.
 */

export interface ParityRow {
  stored: string
  expected: string
  email: string
  url: string
}

export interface ParitySummary {
  checked: number
  storedVsImporter: number
  expressionVsImporter: number
  storedVsExpression: number
  /** `T3->untiered` style: stored (or expression) label, then the importer's. */
  storedVsImporterPairs: Record<string, number>
  expressionVsImporterPairs: Record<string, number>
  /** Of the stored-vs-importer disagreements, how many are a login with no '@'. */
  noAtSign: number
  /** What the rows the CURRENT expression gets wrong look like (see shapeOf), most common first. */
  expressionVsImporterShapes: Record<string, number>
  stoppedEarly: boolean
}

const label = (tier: string) => (tier === '' ? 'untiered' : tier)

/** `stored<TAB>expected<TAB>email<TAB>url`, the last two with ClickHouse TSV escapes (see parseCandidateLine). */
export function parseParityLine(line: string): ParityRow {
  const first = line.indexOf('\t')
  const second = first === -1 ? -1 : line.indexOf('\t', first + 1)
  if (first === -1 || second === -1) throw new Error('malformed parity line: expected stored, expected, email and url')
  const { email, url } = parseCandidateLine(line.slice(second + 1))
  return { stored: line.slice(0, first), expected: line.slice(first + 1, second), email, url }
}

const SHAPE_PART_MAX = 60

/** Letters and digits collapse to runs `a` / `9`; punctuation stays. */
const maskRuns = (s: string) => s.replace(/[A-Za-z]+/g, 'a').replace(/[0-9]+/g, '9')

function emailShape(email: string): string {
  if (email === '') return '(empty)'
  const at = email.lastIndexOf('@')
  if (at === -1) return maskRuns(email).slice(0, SHAPE_PART_MAX)
  const labels = email.slice(at + 1).split('.')
  const last = labels.pop() ?? ''
  const tld = labels.length > 0 && /^[A-Za-z]{1,24}$/.test(last) ? last : maskRuns(last)
  return `${maskRuns(email.slice(0, at))}@${[...labels.map(() => 'x'), tld].join('.')}`.slice(0, SHAPE_PART_MAX)
}

function hostShape(host: string): string {
  if (host === '') return ''
  if (host.startsWith('[')) return '[ip6]'
  const trailingDot = host.endsWith('.')
  const labels = (trailingDot ? host.slice(0, -1) : host).split('.')
  const last = labels.pop() ?? ''
  // The top-level label is what the tier lookup reads; a single-label host (http://jira/) could be an internal name.
  const tld = labels.length > 0 && /^[A-Za-z]{1,24}$/.test(last) ? last : /[A-Z]/.test(last) ? 'X' : 'x'
  const rest = labels.map(l => (/[A-Z]/.test(l) ? 'X' : 'x'))
  return [...rest, tld].join('.') + (trailingDot ? '.' : '')
}

function urlShape(url: string): string {
  if (url === '') return '(empty)'
  let rest = url
  let scheme = ''
  const m = /^([A-Za-z][A-Za-z0-9+.-]{0,11}):\/\//.exec(rest)
  if (m) {
    scheme = m[0]
    rest = rest.slice(m[0].length)
  }
  const cut = rest.search(/[/?#]/)
  const authority = cut === -1 ? rest : rest.slice(0, cut)
  const tail = cut === -1 ? '' : rest.slice(cut)
  const at = authority.lastIndexOf('@')
  const userinfo = at === -1 ? '' : `${maskRuns(authority.slice(0, at))}@`
  let hostPort = at === -1 ? authority : authority.slice(at + 1)
  let port = ''
  const pm = /^(.*?)(:[0-9]+)$/.exec(hostPort)
  if (pm && !hostPort.startsWith('[')) {
    hostPort = pm[1]
    port = ':9'
  } else if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']')
    port = close !== -1 && /^:[0-9]+$/.test(hostPort.slice(close + 1)) ? ':9' : ''
    hostPort = '[' + (close === -1 ? '' : '')
  }
  return `${scheme}${userinfo}${hostShape(hostPort)}${port}${maskRuns(tail)}`.slice(0, SHAPE_PART_MAX)
}

/**
 * A description of a row that is enough to see why two classifiers disagree (no scheme, userinfo, a trailing dot,
 * upper case, a port) and not enough to identify it: letters and digits collapse to runs, host labels to `x`, and
 * only the punctuation and the top-level label survive.
 */
export function shapeOf(row: ParityRow): string {
  return `${emailShape(row.email)} | ${urlShape(row.url)}`
}

export class TierParity {
  private checked = 0
  private storedVsImporter = 0
  private expressionVsImporter = 0
  private storedVsExpression = 0
  private noAtSign = 0
  private readonly storedPairs: Record<string, number> = {}
  private readonly expressionPairs: Record<string, number> = {}
  private readonly expressionShapes: Record<string, number> = {}
  private reachedCap = false

  /** `maxMismatches`: stop reading once this many stored-vs-importer plus expression-vs-importer rows were seen. */
  constructor(private readonly maxMismatches: number = Number.POSITIVE_INFINITY) {}

  get done(): boolean {
    return this.reachedCap
  }

  add(row: ParityRow): void {
    if (this.reachedCap) return
    this.checked++
    const importer = classifyTier(row.email, row.url)
    if (row.stored !== importer) {
      this.storedVsImporter++
      const key = `${label(row.stored)}->${label(importer)}`
      this.storedPairs[key] = (this.storedPairs[key] ?? 0) + 1
      if (!row.email.includes('@')) this.noAtSign++
    }
    if (row.expected !== importer) {
      this.expressionVsImporter++
      const key = `${label(row.expected)}->${label(importer)}`
      this.expressionPairs[key] = (this.expressionPairs[key] ?? 0) + 1
      const shape = shapeOf(row)
      // Bounded: a badly wrong expression could otherwise create one key per row.
      if (shape in this.expressionShapes || Object.keys(this.expressionShapes).length < 500) {
        this.expressionShapes[shape] = (this.expressionShapes[shape] ?? 0) + 1
      }
    }
    if (row.stored !== row.expected) this.storedVsExpression++
    if (this.storedVsImporter + this.expressionVsImporter >= this.maxMismatches) this.reachedCap = true
  }

  summary(): ParitySummary {
    return {
      checked: this.checked,
      storedVsImporter: this.storedVsImporter,
      expressionVsImporter: this.expressionVsImporter,
      storedVsExpression: this.storedVsExpression,
      storedVsImporterPairs: { ...this.storedPairs },
      expressionVsImporterPairs: { ...this.expressionPairs },
      noAtSign: this.noAtSign,
      expressionVsImporterShapes: Object.fromEntries(Object.entries(this.expressionShapes).sort((a, b) => b[1] - a[1])),
      stoppedEarly: this.reachedCap,
    }
  }
}

const pct = (n: number, of: number) => (of === 0 ? '0%' : `${((100 * n) / of).toFixed(4)}%`)
const pairsText = (pairs: Record<string, number>) =>
  Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(', ') || '-'

function shapeLines(s: ParitySummary): string[] {
  const top = Object.entries(s.expressionVsImporterShapes).slice(0, 12)
  if (top.length === 0) return []
  return [
    'shapes of expression-vs-importer disagreements (letters/digits collapsed, TLD kept):',
    ...top.map(([shape, n]) => `  ${String(n).padStart(6)}  ${shape}`),
  ]
}

export function formatParityReport(s: ParitySummary): string {
  return [
    `rows checked:                 ${s.checked.toLocaleString('en-US')}${s.stoppedEarly ? '  (stopped early: mismatch cap reached)' : ''}`,
    `stored vs importer:           ${s.storedVsImporter.toLocaleString('en-US')} (${pct(s.storedVsImporter, s.checked)})   ${pairsText(s.storedVsImporterPairs)}`,
    `  of which no "@" in login:   ${s.noAtSign.toLocaleString('en-US')}`,
    `expression vs importer:       ${s.expressionVsImporter.toLocaleString('en-US')} (${pct(s.expressionVsImporter, s.checked)})   ${pairsText(s.expressionVsImporterPairs)}`,
    `stored vs expression:         ${s.storedVsExpression.toLocaleString('en-US')} (${pct(s.storedVsExpression, s.checked)})`,
    ...shapeLines(s),
    `parity-result: checked=${s.checked} stored_vs_importer=${s.storedVsImporter} expression_vs_importer=${s.expressionVsImporter} stored_vs_expression=${s.storedVsExpression} stopped_early=${s.stoppedEarly ? 1 : 0}`,
  ].join('\n') + '\n'
}
