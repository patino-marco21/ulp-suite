import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('hard T3 deployment policy', () => {
  test('Compose defaults hard-drop tiers to T3', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    expect(compose).toContain(
      'INGEST_FILTER_HARD_DROP_TIERS: ${INGEST_FILTER_HARD_DROP_TIERS:-T3}',
    )
  })

  test('the environment example documents T3 without soft T2/T3 defaults', () => {
    const env = readFileSync('.env.example', 'utf8')
    expect(env).toContain('INGEST_FILTER_HARD_DROP_TIERS=T3')
    expect(env).toContain('non-overridable')
  })

  test('T3 purge is fixed, dry-run-first, and verifies completion', () => {
    const script = readFileSync('scripts/purge-existing-t3.sh', 'utf8')
    expect(script).toContain("country_tier = 'T3'")
    expect(script).toContain('APPLY="${APPLY:-0}"')
    expect(script).toContain('BACKUP_VERIFIED="${BACKUP_VERIFIED:-0}"')
    expect(script).toContain('system.mutations')
    expect(script).toContain('latest_fail_reason')
    expect(script).toContain('remaining_t3')
    expect(script).not.toMatch(/SELECT[^\n]*password/i)
  })
})
