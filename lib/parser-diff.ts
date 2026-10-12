/** Names the reason the result for one line differs between a baseline parser and parser v6 (scripts/parser-diff.ts). "unexplained" must stay at 0. */
import { holdsCredential, isUrlPathParameter, pipeJoinAll, protocolRelativeToPlain, recoverAndroidAppLine, splitNumericLogin, splitSlashInPassword, splitSpacePaddedColons } from '@/lib/ulp-recover'
import { stripTelegramTag } from '@/lib/ulp-telegram-tag'
import { repairUtf8Line } from '@/lib/ulp-utf8'

export interface Outcome { credential: { url: string; email: string; password: string } | null; reason: string | null }

export type ChangeClass =
  | 'same' | 'padded-colons' | 'android-no-scheme' | 'slash-in-password' | 'numeric-login' | 'protocol-relative'
  | 'utf8-recovered' | 'utf8-value' | 'utf8-lost' | 'login-equals-password' | 't3-kept' | 'pipe-scheme' | 'pipe-label' | 'pipe-url' | 'semicolon-password' | 'semicolon-parameter' | 'unexplained'

export const CHANGE_CLASSES: ChangeClass[] = [
  'padded-colons', 'android-no-scheme', 'slash-in-password', 'numeric-login', 'protocol-relative',
  'utf8-recovered', 'utf8-value', 'utf8-lost', 'login-equals-password', 't3-kept', 'pipe-scheme', 'pipe-label', 'pipe-url', 'semicolon-password', 'semicolon-parameter', 'unexplained',
]

const INERT = '\uE000'   // a private-use character: no parser rule knows it, so a line that holds it is read like one without a semicolon

/**
 * The line with its semicolons made inert, and which rule says they are ordinary characters: 'semicolon-password' (no tab, a ';', and a complete credential in front
 * of the first one: rule I) or 'semicolon-parameter' (a ";name=value" path parameter in a url). Null when neither applies.
 */
export function inertSemicolons(line: string): { kind: 'semicolon-password' | 'semicolon-parameter'; line: string } | null {
  // "//host/path;x=y:login:pass" is read as the scheme-less line behind the slashes (rule E), and parseLine cuts a Telegram tag before anything else looks at the line
  const base = stripTelegramTag(protocolRelativeToPlain(line) ?? line)
  // With a semicolon in the line a pipe is noise: parseLine reads the (trimmed) text in front of the first pipe only, unless the line starts with the pipe
  const cut = base.includes(';') && base.includes('|') && !base.startsWith('|')
  const core = (cut ? base.slice(0, base.indexOf('|')) : base).trim()
  const semi = core.indexOf(';')
  if (semi <= 0 || core.includes('\t')) return null
  const kind = holdsCredential(core.slice(0, semi)) ? 'semicolon-password' : isUrlPathParameter(core) ? 'semicolon-parameter' : null
  if (!kind) return null
  // rule I also drops the semicolons at the very end of a complete credential, so the inert reading drops them too
  return { kind, line: (kind === 'semicolon-password' && !isUrlPathParameter(core) ? core.replace(/;+\s*$/, '') : core).replace(/;/g, INERT) }
}

/** An outcome read from an inert-semicolon line, with the semicolons put back. */
export function restoreSemicolons(o: Outcome): Outcome {
  const back = (v: string) => v.split(INERT).join(';')
  return { credential: o.credential && { url: back(o.credential.url), email: back(o.credential.email), password: back(o.credential.password) }, reason: o.reason }
}

type Cred = NonNullable<Outcome['credential']>
const sameCred = (a: Cred, b: Cred) => a.url === b.url && a.email === b.email && a.password === b.password
const sameOutcome = (a: Outcome, b: Outcome) => (a.credential && b.credential ? sameCred(a.credential, b.credential) : !a.credential && !b.credential)

/**
 * `oldOnRepaired` is the baseline parser run on the UTF-8-repaired line: when it already gives the new result, the repair alone explains the change.
 * `oldOnJoined` is the baseline parser run on the line with the pipe that joins a url and a credential replaced (pipeJoinAll): the new result must be exactly that.
 * `oldOnSemi` is the baseline parser run on the line with its semicolons made inert (inertSemicolons, results mapped back with restoreSemicolons).
 */
export function classifyChange(rawLine: string, oldO: Outcome, newO: Outcome, oldOnRepaired: Outcome, oldOnJoined?: Outcome, oldOnSemi?: Outcome): ChangeClass {
  // An app id without its scheme: the old parser stored it mangled (the whole id in the login) or not at all; whatever the new result is, rule B explains it.
  if (recoverAndroidAppLine(repairUtf8Line(rawLine).trim()) && !sameOutcome(oldO, newO)) return 'android-no-scheme'
  // A pipe between a url (or only its scheme, or a label) and a credential (parser v6.1): explained when the new result is what the baseline parser gives for the joined line.
  if (oldOnJoined && !sameOutcome(oldO, newO) && sameOutcome(oldOnJoined, newO)) {
    const join = pipeJoinAll(repairUtf8Line(rawLine).trim())
    if (join) return `pipe-${join.kind}`
  }
  // A ';' behind a credential that is already complete is part of the password (parser v6.1, rule I), and a ";name=value" path parameter in a url without a scheme is
  // part of the url: explained when the new result is what the baseline parser gives for the line with its semicolons made inert.
  if (oldOnSemi && !sameOutcome(oldO, newO) && sameOutcome(oldOnSemi, newO)) {
    const inert = inertSemicolons(repairUtf8Line(rawLine).trim())
    if (inert) return inert.kind
  }
  if (oldO.credential && newO.credential) {
    if (sameCred(oldO.credential, newO.credential)) return 'same'
    return oldOnRepaired.credential && sameCred(oldOnRepaired.credential, newO.credential) ? 'utf8-value' : 'unexplained'
  }
  if (!oldO.credential && !newO.credential) return 'same'
  // The old parser stored the line and v6 does not: explained when the UTF-8 repair alone makes the old parser reject it too (a password that is
  // two characters long once decoded, the double-encoded replacement character, ...).
  if (oldO.credential) return repairUtf8Line(rawLine) !== rawLine && !oldOnRepaired.credential ? 'utf8-lost' : 'unexplained'
  const stored = newO.credential as Cred
  if (oldO.reason === 'tier_dropped') return 't3-kept'
  if (oldOnRepaired.credential && sameCred(oldOnRepaired.credential, stored)) return 'utf8-recovered'
  // parseLine cuts a pipe tail off before it splits the fields, so the helpers are tried on the whole line and on the part in front of the first pipe
  const full = repairUtf8Line(rawLine).trim()
  for (const t of [full, full.includes('|') ? full.slice(0, full.indexOf('|')).trim() : full]) {
    if (splitSpacePaddedColons(t)) return 'padded-colons'
    if (recoverAndroidAppLine(t)) return 'android-no-scheme'
    if (protocolRelativeToPlain(t)) return 'protocol-relative'
    if (splitSlashInPassword(t)) return 'slash-in-password'
    if (splitNumericLogin(t)) return 'numeric-login'
  }
  if (stored.email === stored.password && !stored.email.includes('@')) return 'login-equals-password'
  return 'unexplained'
}

/** A stored row that only the baseline parser produces (stream mode): the reason it is gone. */
export type OldOnlyClass = 'double-encoded' | 'android-mangled' | 'pipe-join' | 'semicolon-junk' | 'split-junk' | 'positional-merge' | 'utf8-text' | 'unexplained'

export function classifyOldOnlyRow(row: { url: string; email: string; password: string }): OldOnlyClass {
  const fields = [row.url, row.email, row.password]
  if (fields.some(f => /[\u00c2-\u00ef][\u0080-\u00bf]/.test(f))) return 'double-encoded'
  if (/^[A-Za-z0-9_+-]{16,}==@/.test(row.email) || /^(android:)?\/\/[A-Za-z0-9_+-]{16,}==@/.test(row.url)) return 'android-mangled'
  // Parser v6.1, rule I: a ';' in the password of a colon-separated line cut the credential in two: no url, the complete credential as the login
  if (row.url === '' && holdsCredential(row.email)) return 'semicolon-junk'
  // ... and a ';name=value' path parameter in a url without a scheme: the path as the login, the parameter and the credential as the password
  if (row.url === '' && /^[\w-]+(?:\.[\w-]+)+\/\S*$/.test(row.email) && /^[A-Za-z_][\w-]*=[^:\s]*:/.test(row.password)) return 'semicolon-junk'
  // Parser v6.1: what a pipe between a url (or only its scheme, or a label) and a credential used to store: no url, and the scheme, the label or the url as the login
  if (row.url === '' && (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(row.email) || /^[A-Za-z][A-Za-z0-9_-]{0,19}:$/.test(row.email) || /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(row.email))) return 'pipe-join'
  // Parser v6.1: the 3-part split of "url:login:pass;x;y" (or with pipes) left the credential in the url field: a url that holds one (user info before the host is a real url)
  if (holdsCredential(row.url) && !/^[a-z][a-z0-9+.-]*:\/\/[^/@:\s]+:[^/@:\s]*@[^/@:\s]+(?::\d+)?(?:\/\S*)?$/i.test(row.url)) return 'split-junk'
  // ... and the 2-part split of a scheme-less "host/path;name=value...:login:pass": no url, the host and path as the login
  if (row.url === '' && /^[\w-]+(?:\.[\w-]+)+\/\S*$/.test(row.email) && !row.email.includes('@')) return 'semicolon-junk'
  // ... and the 3-part split of a scheme-less "host/path;name=value;...": the path as the url, a name=value parameter as the login
  if (/^[\w-]+(?:\.[\w-]+)+\//.test(row.url) && /^[A-Za-z_][\w-]*=[^:\s]*$/.test(row.email)) return 'semicolon-junk'
  // the junk signature of the old positional fallback: a whole line (it holds a colon) in the login field
  if (row.email.includes(':')) return 'positional-merge'
  if (fields.some(f => /[\u0080-\u00ff]/.test(f))) return 'utf8-text'
  return 'unexplained'
}
