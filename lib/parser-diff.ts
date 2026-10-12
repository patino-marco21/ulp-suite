/** Names the reason the result for one line differs between a baseline parser and parser v6 (scripts/parser-diff.ts). "unexplained" must stay at 0. */
import { protocolRelativeToPlain, recoverAndroidAppLine, splitNumericLogin, splitSlashInPassword, splitSpacePaddedColons } from '@/lib/ulp-recover'
import { repairUtf8Line } from '@/lib/ulp-utf8'

export interface Outcome { credential: { url: string; email: string; password: string } | null; reason: string | null }

export type ChangeClass =
  | 'same' | 'padded-colons' | 'android-no-scheme' | 'slash-in-password' | 'numeric-login' | 'protocol-relative'
  | 'utf8-recovered' | 'utf8-value' | 'utf8-lost' | 'login-equals-password' | 't3-kept' | 'unexplained'

export const CHANGE_CLASSES: ChangeClass[] = [
  'padded-colons', 'android-no-scheme', 'slash-in-password', 'numeric-login', 'protocol-relative',
  'utf8-recovered', 'utf8-value', 'utf8-lost', 'login-equals-password', 't3-kept', 'unexplained',
]

type Cred = NonNullable<Outcome['credential']>
const sameCred = (a: Cred, b: Cred) => a.url === b.url && a.email === b.email && a.password === b.password
const sameOutcome = (a: Outcome, b: Outcome) => (a.credential && b.credential ? sameCred(a.credential, b.credential) : !a.credential && !b.credential)

/** `oldOnRepaired` is the baseline parser run on the UTF-8-repaired line: when it already gives the new result, the repair alone explains the change. */
export function classifyChange(rawLine: string, oldO: Outcome, newO: Outcome, oldOnRepaired: Outcome): ChangeClass {
  // An app id without its scheme: the old parser stored it mangled (the whole id in the login) or not at all; whatever the new result is, rule B explains it.
  if (recoverAndroidAppLine(repairUtf8Line(rawLine).trim()) && !sameOutcome(oldO, newO)) return 'android-no-scheme'
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
export type OldOnlyClass = 'double-encoded' | 'android-mangled' | 'positional-merge' | 'utf8-text' | 'unexplained'

export function classifyOldOnlyRow(row: { url: string; email: string; password: string }): OldOnlyClass {
  const fields = [row.url, row.email, row.password]
  if (fields.some(f => /[\u00c2-\u00ef][\u0080-\u00bf]/.test(f))) return 'double-encoded'
  if (/^[A-Za-z0-9_+-]{16,}==@/.test(row.email) || /^(android:)?\/\/[A-Za-z0-9_+-]{16,}==@/.test(row.url)) return 'android-mangled'
  // the junk signature of the old positional fallback: a whole line (it holds a colon) in the login field
  if (row.email.includes(':')) return 'positional-merge'
  if (fields.some(f => /[\u0080-\u00ff]/.test(f))) return 'utf8-text'
  return 'unexplained'
}
