/**
 * Plain text only (owner rule 2026-11-14): there is no archive reader left to attack. These checks read the source, so a later change that brings a zip reader back
 * into the intake fails here instead of passing unnoticed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full)
  }
  return out
}

describe('no archive reader in the intake', () => {
  it('no file under lib/ or app/ imports a zip library', () => {
    const offenders = [...sourceFiles(join(root, 'lib')), ...sourceFiles(join(root, 'app'))]
      .filter(f => /from\s+['"](yauzl|adm-zip|jszip|unzipper|node-stream-zip|decompress)['"]/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the upload processor has no zip entry point', () => {
    const src = readFileSync(join(root, 'lib', 'upload-processor.ts'), 'utf8')
    expect(src).not.toMatch(/processZip|processZipEntries|MAX_ZIP_/)
  })

  it('package.json carries no zip reader', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(all.filter(n => /yauzl|adm-zip|jszip|unzipper|node-stream-zip/.test(n))).toEqual([])
  })
})
