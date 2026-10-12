/** Names the reason the result for one line differs between a baseline parser and parser v6 (scripts/parser-diff.ts). "unexplained" must stay at 0. */
import { protocolRelativeToPlain, recoverAndroidAppLine, splitNumericLogin, splitSlashInPassword, splitSpacePaddedColons } from '@/lib/ulp-recover'
import { repairUtf8Line } from '@/lib/ulp-utf8'

export interface Outcome { credential: { url: string; email: string; password: string } | null; reason: string | null }

export type ChangeClass =
  | 'same' | 'padded-colons' | 'android-no-scheme' | 'slash-in-password' | 'numeric-login' | 'protocol-relative'
  | 'utf8-recovered' | 'utf8-value' | 'login-equals-password' | 't3-kept' | 'unexplained'

export const CHANGE_CLASSES: ChangeClass[] = [
  'padded-colons', 'android-no-scheme', 'slash-in-password', 'numeric-login', 'protocol-relative',
  'utf8-recovered', 'utf8-value', 'login-equals-password', 't3-kept', 'unexplained',
]

type Cred = NonNullable<Outcome['credential']>
const sameCred = (a: Cred, b: Cred) => a.url === b.url && a.email === b.email && a.password === b.password

/** `oldOnRepaired` is the baseline parser run on the UTF-8-repaired line: when it already gives the new result, the repair alone explains the change. */
export function classifyChange(rawLine: string, oldO: Outcome, newO: Outcome, oldOnRepaired: Outcome): ChangeClass {
  if (oldO.credential && newO.credential) {
    if (sameCred(oldO.credential, newO.credential)) return 'same'
    return oldOnRepaired.credential && sameCred(oldOnRepaired.credential, newO.credential) ? 'utf8-value' : 'unexplained'
  }
  if (!oldO.credential && !newO.credential) return 'same'
  if (oldO.credential) return 'unexplained'                       // the old parser stored it and v6 does not
  const stored = newO.credential as Cred
  if (oldO.reason === 'tier_dropped') return 't3-kept'
  if (oldOnRepaired.credential && sameCred(oldOnRepaired.credential, stored)) return 'utf8-recovered'
  const t = repairUtf8Line(rawLine).trim()
  if (splitSpacePaddedColons(t)) return 'padded-colons'
  if (recoverAndroidAppLine(t)) return 'android-no-scheme'
  if (protocolRelativeToPlain(t)) return 'protocol-relative'
  if (splitSlashInPassword(t)) return 'slash-in-password'
  if (splitNumericLogin(t)) return 'numeric-login'
  if (stored.email === stored.password && !stored.email.includes('@')) return 'login-equals-password'
  return 'unexplained'
}
