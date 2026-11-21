/**
 * The address a domain in the tables opens (design: docs/superpowers/specs/2026-11-21-mark-display-and-open-link-design.md): the front page of the host the
 * counts name, over https. Only the host is ever used. What a person pasted can be a whole URL, with a path or a query that holds a login and a password
 * (a credential line is `url:login:password`), and opening that page would send it to the site; the counts drop the path of an entry as well.
 */

/** Characters that cannot be in a plain host. `new URL` would drop a tab or a newline and take the rest, so they are refused before it is asked. */
const NOT_IN_A_HOST = /[\s\u0000-\u001f\u007f/\\?#@:%<>[\]()"'`|^{}]/

/** The URL to open for `host`, or null when it is not a plain host (then the table shows no link). */
export function siteUrl(host: string): string | null {
  if (host === '' || NOT_IN_A_HOST.test(host)) return null
  try {
    const url = new URL(`https://${host}/`)
    const plain = url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && url.search === '' && url.hash === '' && url.pathname === '/'
    return plain ? url.href : null
  } catch {
    return null
  }
}
