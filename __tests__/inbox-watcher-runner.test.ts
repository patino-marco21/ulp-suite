import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

describe('inbox watcher: imports run under the stall watchdog', () => {
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('imports runImportJob and processTextFile, and no longer hand-builds a stream', () => {
    expect(source).toMatch(/import\s*\{[^}]*runImportJob[^}]*\}\s*from\s*['"]@\/lib\/import-runner['"]/)
    expect(source).toMatch(/import\s*\{[^}]*processTextFile[^}]*\}\s*from\s*['"]@\/lib\/upload-processor['"]/)
    expect(source).not.toContain('Readable.toWeb')
    expect(source).not.toContain('processTextStream')
  })

  test('the text, the zip and the archive-reference import all run inside runImportJob', () => {
    const afterClaim = source.slice(source.indexOf('claimFileForProcessing(filePath, PROC)'))
    expect(afterClaim.match(/runImportJob\(/g)?.length).toBe(3)
    expect(afterClaim).toContain('processZipFile(claimedPath')
    expect(afterClaim).toContain('processTextFile(claimedPath')
    expect(afterClaim).toContain('processArchiveRef(claimedPath')
  })

  test('the task still clears its in-flight state in a finally, so the slot and the inFlight entry are always released', () => {
    expect(source).toMatch(/finally \{\s*setCurrentProgress\(null\)/)
  })
})
