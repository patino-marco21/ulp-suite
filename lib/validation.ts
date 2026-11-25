// The rules for a new password. Every rule that fails is reported, in this order, so the form can show them all at once.
const RULES: ReadonlyArray<[(value: string) => boolean, string]> = [
  [(v) => v.length >= 12, 'Password must be at least 12 characters'],
  [(v) => /[A-Z]/.test(v), 'Password must contain at least one uppercase letter'],
  [(v) => /[a-z]/.test(v), 'Password must contain at least one lowercase letter'],
  [(v) => /[0-9]/.test(v), 'Password must contain at least one number'],
  [(v) => /[^A-Za-z0-9]/.test(v), 'Password must contain at least one special character'],
]

/** The messages for every rule `value` breaks; an empty list means the password is acceptable. */
export function passwordProblems(value: unknown): string[] {
  if (typeof value !== 'string') {
    if (value === undefined) return ['Required']
    return [`Expected string, received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`]
  }
  return RULES.filter(([passes]) => !passes(value)).map(([, message]) => message)
}
