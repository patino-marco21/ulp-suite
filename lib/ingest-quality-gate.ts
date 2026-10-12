/**
 * The ingest quality gate (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, Part 2).
 *
 * A correctly parsed row never breaks a few invariants: a login that is a URL, a url that holds a whole credential, a Telegram link inside a field, UTF-8
 * text read as Latin-1. The importer counts the breaks while it stages a file; when they pass a threshold the file is HELD before one row reaches
 * ulp.credentials, with a report that says why. The two worst parser defects of the pile import were visible in a two-minute sample of the file.
 *
 * Everything here is pure: counters, a config, a verdict. It only counts; it never changes what the parser produces. The counters belong to ONE import (no
 * module state), so two imports running side by side cannot mix. A report holds counts and masked shapes, never a line of a file.
 */
import { holdsCredential } from '@/lib/ulp-recover'
import type { RejectionReason } from '@/lib/ulp-parser'

// ─── What a stored row must never look like ───────────────────────────────────

export const GATE_KINDS = [
  'login-is-scheme-or-ends-colon',
  'login-has-scheme',
  'login-has-slash',
  'login-has-colon',
  'login-is-bare-host',
  'url-holds-credential',
  'password-has-scheme',
  'telegram-link-in-field',
  'double-encoded-text',
] as const

export type GateKind = (typeof GATE_KINDS)[number]

const LOGIN_IS_URL = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i
const BARE_HOST = /^[\w-]+(?:\.[\w-]+)+$/
const TELEGRAM_LINK = /t\.me\//i
// UTF-8 text that was read as Latin-1 and written out as UTF-8 again: a lead byte (U+00C2..U+00EF) followed by a continuation byte (U+0080..U+00BF).
const DOUBLE_ENCODED = /[\u00C2-\u00EF][\u0080-\u00BF]/

/**
 * `holdsCredential` (lib/ulp-recover.ts) without its two allocations for the commonest url, "scheme://host/path": exactly one colon, and it starts the "://".
 * It answers exactly like holdsCredential (the test compares them).
 */
export function urlHoldsCredential(url: string): boolean {
  const first = url.indexOf(':')
  if (first === -1) return false
  if (url.charCodeAt(first + 1) === 47 && url.charCodeAt(first + 2) === 47 && url.indexOf(':', first + 1) === -1) return false
  return holdsCredential(url)
}

/** "t.me/" contains a slash, so the regex only runs on the (rare) field that has one. */
const hasTelegramLink = (s: string): boolean => s.includes('/') && TELEGRAM_LINK.test(s)

/**
 * The first invariant a stored row breaks, or null. Each row is counted once, under the first kind that matches, in the order of GATE_KINDS. This runs for every
 * row of every import, so the clean row's path is short: no colon in the login rules out three kinds at once.
 */
export function classifyStoredRow(url: string, login: string, password: string): GateKind | null {
  const hasColon = login.includes(':')
  if (hasColon) {
    if (LOGIN_IS_URL.test(login) || login.endsWith(':')) return 'login-is-scheme-or-ends-colon'
    if (login.includes('://')) return 'login-has-scheme'
  }
  if (login.includes('/') && !url.startsWith('android://')) return 'login-has-slash'
  if (hasColon) return 'login-has-colon'
  if (url === '' && !login.includes('@') && BARE_HOST.test(login)) return 'login-is-bare-host'
  if (urlHoldsCredential(url)) return 'url-holds-credential'
  if (password.includes('://')) return 'password-has-scheme'
  if (hasTelegramLink(password) || hasTelegramLink(login)) return 'telegram-link-in-field'
  if (DOUBLE_ENCODED.test(password)) return 'double-encoded-text'
  return null
}

// ─── Counters (one set per import) ────────────────────────────────────────────

export const SHAPE_CAP = 500
const OTHER_SHAPES = '(other shapes)'
const REPORT_SHAPES = 20
const FIELD_SHAPE_CHARS = 60
const WORD_RUN = /[\p{L}\p{N}_.~-]+/gu

export interface GateCounters {
  /** Non-blank lines read: the rows the parser kept plus every rejected line that is not blank. */
  lines: number
  /** Rows the parser kept (before the tier filter). */
  stored: number
  /** Stored rows that break a rule. */
  junk: number
  noFields: number
  noPassword: number
  garbage: number
  tierDropped: number
  dedup: number
  /** Rows the classifier threw on. It never fails an import. */
  gateErrors: number
  kinds: Record<GateKind, number>
  /** Masked shapes of the junk rows, at most SHAPE_CAP distinct ones. */
  shapes: Map<string, number>
}

export function newGateCounters(): GateCounters {
  return {
    lines: 0, stored: 0, junk: 0, noFields: 0, noPassword: 0, garbage: 0, tierDropped: 0, dedup: 0, gateErrors: 0,
    kinds: Object.fromEntries(GATE_KINDS.map(k => [k, 0])) as Record<GateKind, number>,
    shapes: new Map(),
  }
}

/** What parseULPStream yields per batch (lib/ulp-parser.ts StreamBatch), as far as the gate needs it. */
export interface GateBatch {
  credentials: ReadonlyArray<{ url: string; email: string; password: string }>
  rejected: number
  breakdown: Partial<Record<RejectionReason, number>>
}

/** Every run of letters, digits, '_', '.', '~' and '-' (any script) becomes w, white space collapses, only the punctuation stays. Looks at no more than `max` characters. */
export function maskText(s: string, max = FIELD_SHAPE_CHARS): string {
  return s.slice(0, max).replace(WORD_RUN, 'w').replace(/\s+/g, ' ')
}

/** "w://w/w | w@w | w": the masked url, login and password of a row. */
export function maskShape(url: string, login: string, password: string): string {
  return `${maskText(url)} | ${maskText(login)} | ${maskText(password)}`
}

function noteShape(c: GateCounters, url: string, login: string, password: string): void {
  const shape = maskShape(url, login, password)
  const key = c.shapes.has(shape) || c.shapes.size < SHAPE_CAP ? shape : OTHER_SHAPES
  c.shapes.set(key, (c.shapes.get(key) ?? 0) + 1)
}

/** Adds one parser batch to the counters. Never throws. */
export function recordGateBatch(c: GateCounters, batch: GateBatch): void {
  const b = batch.breakdown
  c.lines += batch.credentials.length + batch.rejected - (b.blank ?? 0)
  c.stored += batch.credentials.length
  c.noFields += b.no_fields ?? 0
  c.noPassword += b.no_password ?? 0
  c.garbage += b.garbage ?? 0
  c.tierDropped += b.tier_dropped ?? 0
  c.dedup += b.dedup ?? 0
  for (const cred of batch.credentials) {
    try {
      const kind = classifyStoredRow(cred.url, cred.email, cred.password)
      if (kind === null) continue
      c.junk++
      c.kinds[kind]++
      noteShape(c, cred.url, cred.email, cred.password)
    } catch {
      c.gateErrors++
    }
  }
}

// ─── Configuration ────────────────────────────────────────────────────────────

export type GateMode = 'hold' | 'warn' | 'off'

export interface GateConfig {
  mode: GateMode
  /** Fewer lines than this and the verdict is at most a warn. */
  minLines: number
  /** The early check runs once the first batch that brings the count to this many lines has been parsed. */
  earlyLines: number
  holdJunkPct: number
  holdUnsplitPct: number
  holdGarbagePct: number
  warnJunkPct: number
  warnUnsplitPct: number
}

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function whole(raw: string | undefined, fallback: number): number {
  const n = Math.floor(positive(raw, fallback))
  return n >= 1 ? n : fallback
}

/** Reads INGEST_QUALITY_GATE*. Anything that is not a positive number falls back to the default; an unknown mode is `hold`. */
export function parseGateConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const mode = (env.INGEST_QUALITY_GATE ?? '').trim().toLowerCase()
  return {
    mode: mode === 'warn' || mode === 'off' ? mode : 'hold',
    minLines: whole(env.INGEST_QUALITY_GATE_MIN_LINES, 20_000),
    earlyLines: whole(env.INGEST_QUALITY_GATE_EARLY_LINES, 1_000_000),
    holdJunkPct: positive(env.INGEST_QUALITY_GATE_JUNK_PCT, 2),
    holdUnsplitPct: positive(env.INGEST_QUALITY_GATE_UNSPLIT_PCT, 5),
    holdGarbagePct: positive(env.INGEST_QUALITY_GATE_GARBAGE_PCT, 25),
    warnJunkPct: positive(env.INGEST_QUALITY_GATE_WARN_JUNK_PCT, 1),
    warnUnsplitPct: positive(env.INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT, 2),
  }
}

// ─── Verdict ──────────────────────────────────────────────────────────────────

export type GateLevel = 'pass' | 'warn' | 'hold'

export interface GateReport {
  v: 1
  phase: 'early' | 'final'
  level: GateLevel
  reasons: string[]
  lines: number
  stored: number
  junk: number
  noFields: number
  noPassword: number
  garbage: number
  tierDropped: number
  gateErrors: number
  junkPct: number
  unsplitPct: number
  garbagePct: number
  /** Only the kinds that occurred. */
  kinds: Partial<Record<GateKind, number>>
  /** The most frequent masked shapes of the junk rows. */
  shapes: Array<{ shape: string; count: number }>
  thresholds: {
    minLines: number
    holdJunkPct: number
    holdUnsplitPct: number
    holdGarbagePct: number
    warnJunkPct: number
    warnUnsplitPct: number
  }
}

export interface GateVerdict {
  level: GateLevel
  reasons: string[]
  report: GateReport
}

const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0)
const round2 = (x: number) => Math.round(x * 100) / 100
/** n / d is above `limit` percent. Integer arithmetic where the inputs are integers, so exactly 2.00% is not above 2%. */
const above = (n: number, d: number, limit: number) => d > 0 && n * 100 > limit * d

export function evaluateGate(c: GateCounters, cfg: GateConfig, phase: 'early' | 'final'): GateVerdict {
  const junkPct = round2(pct(c.junk, c.stored))
  const unsplitPct = round2(pct(c.noFields, c.lines))
  const garbagePct = round2(pct(c.garbage, c.lines))

  const holdReasons: string[] = []
  if (above(c.junk, c.stored, cfg.holdJunkPct)) holdReasons.push(`${junkPct.toFixed(2)}% of the stored rows break a rule (limit ${cfg.holdJunkPct}%)`)
  if (above(c.noFields, c.lines, cfg.holdUnsplitPct)) holdReasons.push(`${unsplitPct.toFixed(2)}% of the lines could not be split (limit ${cfg.holdUnsplitPct}%)`)
  if (above(c.garbage, c.lines, cfg.holdGarbagePct)) holdReasons.push(`${garbagePct.toFixed(2)}% of the lines are garbage (limit ${cfg.holdGarbagePct}%)`)

  const warnReasons: string[] = []
  if (above(c.junk, c.stored, cfg.warnJunkPct)) warnReasons.push(`${junkPct.toFixed(2)}% of the stored rows break a rule (warn limit ${cfg.warnJunkPct}%)`)
  if (above(c.noFields, c.lines, cfg.warnUnsplitPct)) warnReasons.push(`${unsplitPct.toFixed(2)}% of the lines could not be split (warn limit ${cfg.warnUnsplitPct}%)`)
  const gateErrorReason = c.stored > 0 && c.gateErrors * 1000 > c.stored ? `the gate itself failed on ${c.gateErrors} of ${c.stored} rows` : null

  const enough = c.lines >= cfg.minLines
  let level: GateLevel = 'pass'
  let reasons: string[] = []
  if (cfg.mode !== 'off') {
    if (holdReasons.length > 0) {
      level = enough && cfg.mode === 'hold' ? 'hold' : 'warn'
      reasons = holdReasons
    } else if (enough && warnReasons.length > 0) {
      level = 'warn'
      reasons = warnReasons
    }
    if (gateErrorReason) {
      if (level === 'pass') level = 'warn'
      reasons = [...reasons, gateErrorReason]
    }
  }

  const kinds: Partial<Record<GateKind, number>> = {}
  for (const k of GATE_KINDS) if (c.kinds[k] > 0) kinds[k] = c.kinds[k]
  const shapes = [...c.shapes.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, REPORT_SHAPES)
    .map(([shape, count]) => ({ shape, count }))

  const report: GateReport = {
    v: 1, phase, level, reasons,
    lines: c.lines, stored: c.stored, junk: c.junk, noFields: c.noFields, noPassword: c.noPassword, garbage: c.garbage, tierDropped: c.tierDropped, gateErrors: c.gateErrors,
    junkPct, unsplitPct, garbagePct, kinds, shapes,
    thresholds: {
      minLines: cfg.minLines, holdJunkPct: cfg.holdJunkPct, holdUnsplitPct: cfg.holdUnsplitPct, holdGarbagePct: cfg.holdGarbagePct,
      warnJunkPct: cfg.warnJunkPct, warnUnsplitPct: cfg.warnUnsplitPct,
    },
  }
  return { level, reasons, report }
}

/** One log line of numbers; no file content. */
export function describeVerdict(v: GateVerdict): string {
  const r = v.report
  return `${v.level} (${r.phase}): ${r.lines} lines, ${r.stored} stored, junk ${r.junkPct}%, unsplit ${r.unsplitPct}%, garbage ${r.garbagePct}%${v.reasons.length ? `: ${v.reasons.join('; ')}` : ''}`
}

// ─── The error a hold throws ──────────────────────────────────────────────────

export class IngestHeldError extends Error {
  readonly report: GateReport

  constructor(report: GateReport) {
    super(`Held by the quality gate: ${report.reasons.join('; ')}.`)
    this.name = 'IngestHeldError'
    this.report = report
  }
}

/** `instanceof` fails across the app's webpack bundles (the watcher and the routes load separate copies of a module), so the shape counts too. */
export function isIngestHeldError(e: unknown): e is IngestHeldError {
  if (e instanceof IngestHeldError) return true
  return e instanceof Error && e.name === 'IngestHeldError' && typeof (e as { report?: unknown }).report === 'object' && (e as { report?: unknown }).report !== null
}
