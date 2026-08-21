/**
 * Tests for NORM_EXPR sweep part 2.
 *
 * Coverage:
 *  - export route WHERE fragment uses NORM_DOMAIN_EXPR, not raw 'domain'
 *
 * This file previously also guarded a "domain-monitor WHERE fragment" shape,
 * asserted as a hardcoded literal string (not a call into real code) rather
 * than anything exported from lib/domain-monitor.ts. That literal described
 * domain-monitor.ts's live-upload ClickHouse query, which was deleted
 * entirely when the upload-triggered check was rewritten to match credentials
 * in-process instead (see lib/domain-match.ts's matchCredentialsAgainstIndex) —
 * so the section was testing a string against itself and guarding nothing
 * real. Removed rather than retargeted at lib/monitor-rescan-cron.ts's
 * matchConditionSQL: that function is intentionally unexported (a singleton,
 * not a mirrored pair — see the comment above it), and real coverage of its
 * SQL shape already exists in __tests__/monitor-rescan-cron.test.ts via
 * actual runTick() calls inspecting the real SQL text sent to executeQuery,
 * which is a stronger guard than re-typing a literal here ever was.
 */

import { describe, test, expect } from 'vitest'
import { NORM_DOMAIN_EXPR } from '@/lib/ulp-normalize'

// ─────────────────────────────────────────────────────────────────────────────
// export route domain filter WHERE fragment
// ─────────────────────────────────────────────────────────────────────────────

describe('export route domain filter WHERE fragment', () => {
  const whereFragment = ` AND (${NORM_DOMAIN_EXPR}) = {exportDomain:String}`

  test('contains if( — uses normalizing expression not raw column', () => {
    expect(whereFragment).toContain('if(')
  })

  test('does not contain bare "domain ="', () => {
    expect(whereFragment).not.toMatch(/\bdomain\s*=\s*\{/)
  })

  test('contains {exportDomain:String} parameter placeholder', () => {
    expect(whereFragment).toContain('{exportDomain:String}')
  })
})
