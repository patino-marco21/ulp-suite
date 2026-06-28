import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('garbage-purge bounded-memory delete', () => {
  const script = readFileSync('scripts/diagnose-and-purge-garbage.sh', 'utf8')

  test('cancels failed garbage mutations before purging, matched by a stable marker', () => {
    // The garbage predicate is a large multi-line regex expression — too fragile
    // to match by full command-string equality (unlike T3's simple
    // `country_tier = 'T3'`). Match by a short, distinctive substring instead,
    // mirroring lib/content-dedup.ts's MUTATION_MARKER + `command LIKE` pattern.
    expect(script).toContain("unhex('EFBFBD')")
    expect(script).toContain('system.mutations')
    expect(script).toContain('latest_fail_reason')
    expect(script).toContain('KILL MUTATION')
    expect(script).toContain('command LIKE')
  })

  test('refuses to purge while any other credentials mutation is active', () => {
    expect(script).toContain('is_done = 0')
    expect(script).toMatch(/already active|wait before purging/i)
  })

  test('uses bounded-memory lightweight delete, not the heavyweight ALTER TABLE mutation', () => {
    expect(script).toContain('DELETE FROM ulp.credentials')
    expect(script).toContain('lightweight_deletes_sync = 2')
    expect(script).toContain('max_threads = 2')
    expect(script).not.toContain('ALTER TABLE ulp.credentials DELETE WHERE $IS_GARBAGE')
  })
})
