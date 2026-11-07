/**
 * The file ledger's content check (docs/superpowers/specs/2026-11-07-file-ledger-design.md): is this file's exact content already in ulp.sources under another name?
 *
 * ulp.sources is written after a file fully imports, with the file's size, sha256 and the parser revision that read it (lib/parser-version.ts). The same-name guard of
 * lib/upload-processor.ts stops a re-drop of the same name; this decides the case it cannot see, the same bytes under a new name ("(2)", "(Copy)", a rename). Pure, so
 * the rule is tested without a database.
 */
import { PARSER_REVISION, isRefeedName } from '@/lib/parser-version'

/** INGEST_CONTENT_LEDGER=off switches the content check, the hashing of every file and the recording of files that yield nothing off: the importer then behaves as it did before DDL v31. */
export function contentLedgerEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (env.INGEST_CONTENT_LEDGER ?? '').trim().toLowerCase() !== 'off'
}

/** The ledger row a file's content matched: the other name, the parser revision that imported it, and when. */
export interface ContentMatch {
  filename: string
  revision: number
  importedAt: string
}

export type ContentDecision =
  | { action: 'import'; reason: 'no-match' | 'refeed' | 'newer-parser'; match?: ContentMatch }
  | { action: 'skip'; reason: 'same-content'; match: ContentMatch }

/**
 * Skip when the table holds the same bytes under another name and the parser that imported them is the current one or newer. Import when there is no such row, when the
 * name says it is a deliberate re-feed, or when the parser has changed since (the bytes may yield rows they did not yield before; the new ledger row then carries the
 * current revision, so the next copy is skipped).
 */
export function decideContent(match: ContentMatch | null, filename: string, currentRevision: number = PARSER_REVISION): ContentDecision {
  if (!match) return { action: 'import', reason: 'no-match' }
  if (isRefeedName(filename)) return { action: 'import', reason: 'refeed', match }
  if (match.revision < currentRevision) return { action: 'import', reason: 'newer-parser', match }
  return { action: 'skip', reason: 'same-content', match }
}

/** The line the importer logs for a decision with a match (console.warn: the production build strips console.log). */
export function describeDecision(filename: string, d: ContentDecision, currentRevision: number = PARSER_REVISION): string {
  if (d.action === 'skip') {
    return `[ledger] ${filename}: the same bytes were imported as "${d.match.filename}" (parser revision ${d.match.revision}, ${d.match.importedAt}): skipped. Name the file "refeed" to import it again`
  }
  if (d.reason === 'refeed') return `[ledger] ${filename}: the same bytes were imported as "${d.match?.filename}", but the name says re-feed: importing`
  if (d.reason === 'newer-parser') {
    return `[ledger] ${filename}: the same bytes were imported as "${d.match?.filename}" by parser revision ${d.match?.revision}; the parser is now at ${currentRevision}: importing again`
  }
  return ''
}
