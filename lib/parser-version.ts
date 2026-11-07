/**
 * The revision of the line parser (lib/ulp-parser.ts, lib/ulp-recover.ts) as a whole number: v6.5 is 65.
 *
 * ulp.sources records it for every file the importer records (DDL v31, docs/superpowers/specs/2026-11-07-file-ledger-design.md). The importer then skips a file whose exact
 * bytes the table already holds, under another name, only while the parser that imported it is at least as new as this one: after a parser change the same bytes may yield
 * rows they did not yield before.
 *
 * BUMP IT in the commit of any parser change that can add rows from a file an earlier revision already imported (a new layout read, a rule that stops rejecting a line).
 * Not for a change that only removes rows, or only moves the report of the quality gate.
 */
export const PARSER_REVISION = 65

/**
 * A file whose name carries this word is a deliberate re-feed: the owner renames the plaintext "... (refeed v6.5).txt" to import the same bytes again after a parser
 * change. The content check lets such a file through, as it lets through a file the parser has changed for.
 */
export const REFEED_MARKER = /refeed/i

export function isRefeedName(filename: string): boolean {
  return REFEED_MARKER.test(filename)
}

/**
 * The parser revision that was live when a ledger row was written, by the time it was written (UTC): used once, by the backfill of the rows that DDL v31 found with
 * revision 0. The instants are the moments each image replaced the one before it on the laptop (the `rollback-<UTC>` tags taken at those deploys); the pile redo of 2026-10-12
 * is the first run of the v6 parser. Everything earlier ran an older parser: 50 stands for "before v6". Newest first: the lookup takes the first entry the time has reached.
 */
export const PARSER_REVISION_TIMELINE: ReadonlyArray<{ from: string; revision: number }> = [
  { from: '2026-11-06 20:05:00', revision: 65 },
  { from: '2026-11-06 18:25:00', revision: 64 },
  { from: '2026-11-02 06:42:00', revision: 63 },
  { from: '2026-10-25 01:22:00', revision: 62 },
  { from: '2026-10-12 00:00:00', revision: 61 },
]

/** What a row written before the v6 parser carries. */
export const PARSER_REVISION_BEFORE_V6 = 50

/** The revision for a row written at `at` (a 'YYYY-MM-DD HH:MM:SS' string in UTC, as ClickHouse prints a DateTime). */
export function revisionAt(at: string): number {
  for (const step of PARSER_REVISION_TIMELINE) if (at >= step.from) return step.revision
  return PARSER_REVISION_BEFORE_V6
}

/** The ClickHouse expression that maps a DateTime column (or value) to the revision that was live then. */
export function revisionExpression(column = 'imported_at'): string {
  const arms = PARSER_REVISION_TIMELINE.map(s => `${column} >= toDateTime('${s.from}', 'UTC'), ${s.revision}`).join(', ')
  return `multiIf(${arms}, ${PARSER_REVISION_BEFORE_V6})`
}

/**
 * The one UPDATE that gives every row still at revision 0 its revision by the time it was written. A single mutation, and a second run changes nothing (it only touches
 * revision 0). Run by scripts/ledger-backfill.ts, never at start-up.
 */
export function revisionBackfillSql(): string {
  return `ALTER TABLE ulp.sources UPDATE parser_revision = ${revisionExpression()} WHERE parser_revision = 0 SETTINGS mutations_sync = 2`
}
