/**
 * Where a search term is looked up (docs/superpowers/specs/2026-10-13-login-search-scope-design.md).
 *
 *   all             the url, the login and the password and the host columns: the search as it always was
 *   login           the login as a WHOLE WORD: the text index on `email` answers it (about 0.2 s on 1.8 billion rows)
 *   login_contains  anywhere inside the login: a scan of the login column (about 25 s)
 *
 * Shared by the query builder (lib/ulp-search.ts), the two routes and the credentials page, so it holds no server-only code.
 */
export type SearchScope = 'all' | 'login' | 'login_contains'

export const SEARCH_SCOPES: readonly SearchScope[] = ['all', 'login', 'login_contains']

/** The scope a `scope` request parameter names: absent or empty means 'all'; null when it is anything else. */
export function parseSearchScope(raw: unknown): SearchScope | null {
  if (raw === undefined || raw === null || raw === '') return 'all'
  return typeof raw === 'string' && (SEARCH_SCOPES as readonly string[]).includes(raw) ? (raw as SearchScope) : null
}

/** The options of the "Search in" select, in display order. */
export const SEARCH_SCOPE_OPTIONS: ReadonlyArray<{ value: SearchScope; label: string }> = [
  { value: 'all', label: 'All fields' },
  { value: 'login', label: 'Login (whole word)' },
  { value: 'login_contains', label: 'Login (contains)' },
]

/** The search box placeholder for each scope. */
export const SEARCH_SCOPE_PLACEHOLDERS: Record<SearchScope, string> = {
  all: 'Search URL / email / password…',
  login: 'Search login (whole word)…',
  login_contains: 'Search login (contains)…',
}

/** The tooltip of the select. */
export const SEARCH_SCOPE_TITLE =
  'Search in. Whole word is instant; contains scans the whole login column (about 25 s). Type login:name in the box to look a name up as a whole word in the login, whatever this says.'
