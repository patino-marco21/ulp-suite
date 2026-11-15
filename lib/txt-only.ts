/**
 * The intake takes plain text only (owner rule 2026-11-14): archives and similar containers carry a much higher risk of malware, and no .zip or .csv job has
 * ever run in 3,600+ jobs. The inbox watcher and both upload routes share this one rule, so it is stated once. `.archiveref` (the importer's own re-feed
 * reference, never a user file) is the inbox's business alone.
 */

/**
 * Names that say what the file is: archives and other containers, and `.csv`. The inbox refuses them without a look inside. Any other unknown extension is
 * judged by its content (sniffFileKind in lib/inbox-helpers.ts), so a Telegram name with a date fragment for an extension still imports when it is text.
 */
export const REFUSED_EXTS: ReadonlySet<string> = new Set(['.zip', '.rar', '.7z', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.zst', '.csv'])

/** True for a file the upload routes take: the name ends in .txt (any case). */
export function isTxtName(name: string): boolean {
  return name.toLowerCase().endsWith('.txt')
}

/** The extension as the message shows it: lower case, with its dot, or "(none)". */
function shownExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : '(none)'
}

/** The reason given for a refused file, to the API caller and in the job log. `ext` may be an extension (".zip") or a whole file name. */
export function onlyTxtMessage(ext: string): string {
  const shown = ext.startsWith('.') && !ext.slice(1).includes('.') ? ext.toLowerCase() : shownExt(ext)
  return `Only .txt files are accepted. "${shown || '(none)'}" was refused: archives (.zip, .rar, .7z, ...), .csv and other containers are never imported`
}
