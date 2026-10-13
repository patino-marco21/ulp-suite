import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * A skip index on lower(email) is used only when the query writes the identical expression, and a query that compares the
 * raw column to a lowercased value silently misses every address stored with a capital. So no route or library file may
 * compare an address with the raw `email` column again: they build the SQL with lib/address-lookup.ts.
 */
const ROOT = resolve(__dirname, '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = [...sources(join(ROOT, 'app/api')), ...sources(join(ROOT, 'lib'))]

const FORBIDDEN: Array<[string, RegExp]> = [
  ['email = {email:String}', /\bemail = \{email:String\}/],
  ['email != {email:String}', /\bemail != \{email:String\}/],
  ['email IN (${emailList})', /\bemail IN \(\$\{emailList\}\)/],
  ['emailCasings', /\bemailCasings\b/],
  ['(email = {exactemail', /\(email = \{exactemail/],
]

describe('no exact-address lookup compares the raw email column', () => {
  test('the source tree has files to check', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  test.each(FORBIDDEN)('nothing writes %s', (_label, re) => {
    const offenders = files.filter(f => re.test(readFileSync(f, 'utf8'))).map(f => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })
})
