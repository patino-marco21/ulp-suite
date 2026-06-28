import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('garbage-purge bounded-memory delete', () => {
  const script = readFileSync('scripts/diagnose-and-purge-garbage.sh', 'utf8')

  test('cancels failed garbage mutations before purging, matched by a stable marker', () => {
    // The garbage predicate is a large multi-line regex expression — too fragile
    // to match by full command-string equality (unlike T3's simple
    // `country_tier = 'T3'`). Match by a short, distinctive substring instead,
    // mirroring lib/content-dedup.ts's MUTATION_MARKER + `command LIKE` pattern.
    expect(script).toContain('system.mutations')
    expect(script).toContain('latest_fail_reason')
    expect(script).toContain('KILL MUTATION')
    expect(script).toContain('command LIKE')
  })

  test('the marker is safe to embed in a single-quoted LIKE pattern', () => {
    // Regression guard: MUTATION_MARKER="unhex('EFBFBD')" was shipped once and
    // broke production — its own embedded single quotes closed the outer
    // '%...%' string literal early, producing a SQL syntax error (confirmed by
    // reproducing the exact bash interpolation: `'%unhex('EFBFBD')%'` parses as
    // the string `%unhex(`, then the bare token `EFBFBD`, then `)%'` -- not a
    // valid LIKE pattern at all). A marker embedded in '%${MARKER}%' must
    // contain no quote characters of its own.
    const match = script.match(/MUTATION_MARKER="([^"]*)"/)
    expect(match).not.toBeNull()
    const marker = match![1]
    expect(marker).not.toContain("'")
    expect(marker.length).toBeGreaterThan(0)
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
