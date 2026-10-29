/**
 * Which login type a search starts with: the chips Email / Phone / Username / All types of the Credentials page (lib/login-type.ts has the types).
 *
 * The owner picked Email by hand for nearly every search, so a search starts on it: Email whenever the request carries a search text or a domain, every
 * type otherwise. A click on a chip is a CHOICE and holds until Clear (the way Declutter works, lib/declutter-default.ts), "All types" included.
 *
 * Why not for the bare browse and the views that only name a window or a file ("View what this added"): they show everything the import added or the table
 * holds, and a request with a login-type filter loses the free total of a WHERE-free count (lib/credential-totals.ts, the route's dedupeCountExpr).
 * The API is unchanged: no `login_type` parameter still means every type. Pure: the page, its export and its tests all use it.
 */
export interface LoginTypeSearch {
  /** The search box. */
  q: string
  /** The Domain box. */
  domain: string
}

/** The type a search starts on: 'email' when something was typed to search for, '' (every type) when not. */
export function loginTypeByDefault(search: LoginTypeSearch): string {
  return search.q.trim() !== '' || search.domain.trim() !== '' ? 'email' : ''
}

/** The type in force: the click the user made (null = none; '' = All types) or, without one, the search's default. */
export function effectiveLoginType(choice: string | null, search: LoginTypeSearch): string {
  return choice ?? loginTypeByDefault(search)
}
