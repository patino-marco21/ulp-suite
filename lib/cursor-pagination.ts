export type SortKey =
  | 'imported_desc' | 'imported_asc'
  | 'domain_asc'    | 'domain_desc'
  | 'email_asc'     | 'email_desc'
  | 'pw_len_desc'   | 'pw_len_asc'

export const SORT_MAP: Record<SortKey, string> = {
  imported_desc: 'imported_at DESC, domain ASC, email ASC, url ASC, password ASC',
  imported_asc:  'imported_at ASC,  domain ASC, email ASC, url ASC, password ASC',
  domain_asc:    "(domain='') ASC, domain ASC, email ASC, imported_at ASC, url ASC, password ASC",
  domain_desc:   "(domain='') ASC, domain DESC, email ASC, imported_at ASC, url ASC, password ASC",
  email_asc:     'email ASC, domain ASC, imported_at ASC, url ASC, password ASC',
  email_desc:    'email DESC, domain ASC, imported_at ASC, url ASC, password ASC',
  pw_len_desc:   'password_length DESC, domain ASC, email ASC, imported_at ASC, url ASC',
  pw_len_asc:    'password_length ASC,  domain ASC, email ASC, imported_at ASC, url ASC',
}

const CURSOR_COLS: Record<SortKey, string[]> = {
  imported_desc: ['imported_at', 'domain', 'email', 'url', 'password'],
  imported_asc:  ['imported_at', 'domain', 'email', 'url', 'password'],
  domain_asc:    ['domain', 'email', 'imported_at', 'url', 'password'],
  domain_desc:   ['domain', 'email', 'imported_at', 'url', 'password'],
  email_asc:     ['email', 'domain', 'imported_at', 'url', 'password'],
  email_desc:    ['email', 'domain', 'imported_at', 'url', 'password'],
  pw_len_desc:   ['password_length', 'domain', 'email', 'imported_at', 'url'],
  pw_len_asc:    ['password_length', 'domain', 'email', 'imported_at', 'url'],
}

type CursorPayload = { sort: SortKey; v: Record<string, unknown> }

export function encodeCursor(sort: SortKey, row: Record<string, unknown>): string {
  const cols = CURSOR_COLS[sort]
  const v: Record<string, unknown> = {}
  for (const col of cols) v[col] = row[col]
  return Buffer.from(JSON.stringify({ sort, v })).toString('base64')
}

export function decodeCursor(token: string): CursorPayload | null {
  if (!token) return null
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as CursorPayload
  } catch {
    return null
  }
}

export function buildCursorWhere(
  sort: SortKey,
  cursor: CursorPayload,
): { clause: string; params: Record<string, unknown> } {
  const { v } = cursor
  switch (sort) {
    case 'imported_asc':
      return {
        clause: `(imported_at, domain, email, url, password) > ({c_ia:DateTime}, {c_d:String}, {c_e:String}, {c_u:String}, {c_pw:String})`,
        params: { c_ia: v.imported_at, c_d: v.domain, c_e: v.email, c_u: v.url, c_pw: v.password },
      }
    case 'imported_desc':
      return {
        clause: `(imported_at < {c_ia:DateTime} OR (imported_at = {c_ia:DateTime} AND (domain, email, url, password) > ({c_d:String}, {c_e:String}, {c_u:String}, {c_pw:String})))`,
        params: { c_ia: v.imported_at, c_d: v.domain, c_e: v.email, c_u: v.url, c_pw: v.password },
      }
    case 'domain_asc': {
      const isEmpty = (v.domain as string) === ''
      const p = { c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url, c_pw: v.password }
      if (isEmpty) {
        return {
          clause: `(domain = '' AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String}))`,
          params: p,
        }
      }
      return {
        clause: `((domain != '' AND (domain, email, imported_at, url, password) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})) OR domain = '')`,
        params: p,
      }
    }
    case 'domain_desc': {
      const isEmpty = (v.domain as string) === ''
      const p = { c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url, c_pw: v.password }
      if (isEmpty) {
        return {
          clause: `(domain = '' AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String}))`,
          params: p,
        }
      }
      return {
        clause: `((domain != '' AND (domain < {c_d:String} OR (domain = {c_d:String} AND (email, imported_at, url, password) > ({c_e:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})))) OR domain = '')`,
        params: p,
      }
    }
    case 'email_asc':
      return {
        clause: `(email, domain, imported_at, url, password) > ({c_e:String}, {c_d:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})`,
        params: { c_e: v.email, c_d: v.domain, c_ia: v.imported_at, c_u: v.url, c_pw: v.password },
      }
    case 'email_desc':
      return {
        clause: `(email < {c_e:String} OR (email = {c_e:String} AND (domain, imported_at, url, password) > ({c_d:String}, {c_ia:DateTime}, {c_u:String}, {c_pw:String})))`,
        params: { c_e: v.email, c_d: v.domain, c_ia: v.imported_at, c_u: v.url, c_pw: v.password },
      }
    case 'pw_len_asc':
      return {
        clause: `(password_length > {c_pl:UInt8} OR (password_length = {c_pl:UInt8} AND (domain, email, imported_at, url) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String})))`,
        params: { c_pl: v.password_length, c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url },
      }
    case 'pw_len_desc':
      return {
        clause: `(password_length < {c_pl:UInt8} OR (password_length = {c_pl:UInt8} AND (domain, email, imported_at, url) > ({c_d:String}, {c_e:String}, {c_ia:DateTime}, {c_u:String})))`,
        params: { c_pl: v.password_length, c_d: v.domain, c_e: v.email, c_ia: v.imported_at, c_u: v.url },
      }
  }
}
