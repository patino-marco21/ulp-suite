import { parseLine, type ULPCredential } from '@/lib/ulp-parser'
import { unescapeTsv } from '@/lib/tsv'

/**
 * Repair of the "scheme-split" legacy rows in ulp.credentials.
 *
 * Between July and August 2026 an older parser read a combo line `https://host/path|login|pass` by splitting at the
 * scheme's colon and then at the first pipe. It stored url = 'https', email = '//host/path' and password =
 * 'login|pass', with a blank domain (3,288,434 rows on 2026-10-01: 2.17M July, 1.11M August; 99.99% pipe-packed,
 * never a '|' or ':' in the email column). lib/ulp-normalize.ts repairs the display of the space-separated variant
 * (Case C) but nothing repaired these: an exact domain/email filter and the domain monitor cannot see them.
 *
 * Re-reading the ORIGINAL line with the CURRENT parser recovers them: url + ':' + email + '|' + password is the line
 * the parser saw. The result must reproduce those fields exactly (a repair never invents data), and the importer's
 * own hard-drop policy still applies, so a row the importer would reject today is not re-introduced.
 *
 * The old rows are not touched: they are already hidden by the Declutter filter (a single-label host), and a
 * partition rewrite is not something to run on a table with no backup. The repaired rows are appended
 * (scripts/repair-scheme-split-rows.sh), keeping each row's imported_at, source_file and breach_name.
 */

export interface StoredRow {
  url: string
  email: string
  password: string
  source_file: string
}

export interface StoredRowFull extends StoredRow {
  breach_name: string
  imported_at: string
}

/** The same shape as a ClickHouse WHERE clause (domain is the leading sort key, so `domain = ''` keeps it cheap). */
export const SCHEME_SPLIT_PREDICATE =
  "domain = '' AND url IN ('http','https') AND startsWith(email,'//') AND position(email,' ')=0 AND position(email,'|')=0 AND position(email,':')=0 AND position(password,'|')>0"

export function isSchemeSplitRow(row: Pick<StoredRow, 'url' | 'email' | 'password'>): boolean {
  return (
    (row.url === 'http' || row.url === 'https') &&
    row.email.startsWith('//') &&
    !row.email.includes(' ') &&
    !row.email.includes('|') &&
    !row.email.includes(':') &&
    row.password.includes('|')
  )
}

export type RepairOutcome =
  | { kind: 'repaired'; credential: ULPCredential }
  | { kind: 'rejected'; reason: string }

function decodesTo(raw: string, decoded: string): boolean {
  try {
    return decodeURIComponent(raw) === decoded
  } catch {
    return false
  }
}

export function repairSchemeSplit(
  row: StoredRow,
  opts: {
    /** The importer's early hard-tier drop (makeHardDropPredicate): applied by the parser itself. */
    shouldHardDrop?: (email: string, url: string) => boolean
    /** Everything else the importer drops after parsing (shouldDropAtIngest: soft tiers, suffixes, noise). */
    shouldDrop?: (credential: ULPCredential) => boolean
  } = {},
): RepairOutcome {
  if (!isSchemeSplitRow(row)) return { kind: 'rejected', reason: 'not_scheme_split' }

  const line = `${row.url}:${row.email}|${row.password}`
  const { credential, reason } = parseLine(line, row.source_file, opts.shouldHardDrop)
  if (!credential) return { kind: 'rejected', reason: reason ?? 'rejected' }

  // Lossless: the parser may decode a percent-encoded password, but must not otherwise change what was stored.
  const first = line.indexOf('|')
  const second = line.indexOf('|', first + 1)
  const urlPart = line.slice(0, first)
  const loginPart = line.slice(first + 1, second)
  const passPart = line.slice(second + 1)
  const same =
    credential.url === urlPart &&
    credential.email === loginPart &&
    (credential.password === passPart || decodesTo(passPart, credential.password))
  if (!same) return { kind: 'rejected', reason: 'not_lossless' }

  if (opts.shouldDrop?.(credential)) return { kind: 'rejected', reason: 'policy_dropped' }

  return { kind: 'repaired', credential }
}

export interface RepairSummary {
  candidates: number
  repaired: number
  rejected: Record<string, number>
}

export class RepairStats {
  private candidates = 0
  private repaired = 0
  private readonly rejected: Record<string, number> = {}

  add(outcome: RepairOutcome): void {
    this.candidates++
    if (outcome.kind === 'repaired') this.repaired++
    else this.rejected[outcome.reason] = (this.rejected[outcome.reason] ?? 0) + 1
  }

  summary(): RepairSummary {
    return { candidates: this.candidates, repaired: this.repaired, rejected: { ...this.rejected } }
  }
}

/** One line of `SELECT url, email, password, source_file, breach_name, imported_at ... FORMAT TSV`. */
export function parseStoredRowLine(line: string): StoredRowFull {
  const f = line.split('\t')
  if (f.length !== 6) throw new Error(`malformed stored-row line: expected 6 fields, got ${f.length}`)
  return {
    url: unescapeTsv(f[0]),
    email: unescapeTsv(f[1]),
    password: unescapeTsv(f[2]),
    source_file: unescapeTsv(f[3]),
    breach_name: unescapeTsv(f[4]),
    imported_at: f[5],
  }
}
