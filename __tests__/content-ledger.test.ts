import { describe, expect, it } from 'vitest'
import { contentLedgerEnabled, decideContent, describeDecision, type ContentMatch } from '@/lib/content-ledger'
import {
  PARSER_REVISION, PARSER_REVISION_BEFORE_V6, PARSER_REVISION_TIMELINE, isRefeedName, revisionAt, revisionBackfillSql,
} from '@/lib/parser-version'

const match = (revision: number): ContentMatch => ({ filename: 'Original.txt', revision, importedAt: '2026-11-06 21:02:39' })

describe('decideContent', () => {
  it('imports a file whose bytes the ledger does not hold', () => {
    expect(decideContent(null, 'new.txt')).toEqual({ action: 'import', reason: 'no-match' })
  })

  it('skips the same bytes under another name when the parser that imported them is the current one', () => {
    const d = decideContent(match(PARSER_REVISION), 'Original (2).txt')
    expect(d.action).toBe('skip')
    expect(d.reason).toBe('same-content')
  })

  it('skips the same bytes when the parser that imported them is newer than this one (a rollback of the image)', () => {
    expect(decideContent(match(PARSER_REVISION + 1), 'copy.txt').action).toBe('skip')
  })

  it('imports the same bytes again when the parser has changed since, because they may yield rows they did not yield before', () => {
    expect(decideContent(match(PARSER_REVISION - 1), 'copy.txt')).toMatchObject({ action: 'import', reason: 'newer-parser' })
    expect(decideContent(match(0), 'copy.txt')).toMatchObject({ action: 'import', reason: 'newer-parser' })
  })

  it('imports a file named as a deliberate re-feed, whatever the revision', () => {
    expect(decideContent(match(PARSER_REVISION), 'DUMP 01 (refeed v6.5).txt')).toMatchObject({ action: 'import', reason: 'refeed' })
    expect(decideContent(match(PARSER_REVISION), 'DUMP 01 REFEED.txt')).toMatchObject({ action: 'import', reason: 'refeed' })
  })

  it('takes the current revision as a parameter, so the rule is the same at any revision', () => {
    expect(decideContent(match(70), 'x.txt', 70).action).toBe('skip')
    expect(decideContent(match(70), 'x.txt', 71).action).toBe('import')
  })
})

describe('describeDecision', () => {
  it('names the earlier file and the way out in the line of a skip', () => {
    const line = describeDecision('copy.txt', decideContent(match(PARSER_REVISION), 'copy.txt'))
    expect(line).toContain('Original.txt')
    expect(line).toContain('refeed')
    expect(line.startsWith('[ledger] copy.txt')).toBe(true)
  })

  it('says nothing for a file the ledger has never seen', () => {
    expect(describeDecision('new.txt', decideContent(null, 'new.txt'))).toBe('')
  })

  it('says why a file is imported although its bytes are known', () => {
    expect(describeDecision('a refeed.txt', decideContent(match(PARSER_REVISION), 'a refeed.txt'))).toContain('re-feed')
    expect(describeDecision('b.txt', decideContent(match(63), 'b.txt'))).toContain('revision 63')
  })
})

describe('contentLedgerEnabled', () => {
  it('is on unless INGEST_CONTENT_LEDGER says off', () => {
    expect(contentLedgerEnabled({})).toBe(true)
    expect(contentLedgerEnabled({ INGEST_CONTENT_LEDGER: '' })).toBe(true)
    expect(contentLedgerEnabled({ INGEST_CONTENT_LEDGER: 'on' })).toBe(true)
    expect(contentLedgerEnabled({ INGEST_CONTENT_LEDGER: ' OFF ' })).toBe(false)
  })
})

describe('parser revision', () => {
  it('the current revision is the newest step of the timeline', () => {
    expect(PARSER_REVISION_TIMELINE[0].revision).toBe(PARSER_REVISION)
  })

  it('the timeline is newest first and strictly decreasing, so the lookup takes the first step the time has reached', () => {
    for (let i = 1; i < PARSER_REVISION_TIMELINE.length; i++) {
      expect(PARSER_REVISION_TIMELINE[i].from < PARSER_REVISION_TIMELINE[i - 1].from).toBe(true)
      expect(PARSER_REVISION_TIMELINE[i].revision < PARSER_REVISION_TIMELINE[i - 1].revision).toBe(true)
    }
  })

  it('maps the time a row was written to the parser that was live', () => {
    expect(revisionAt('2026-11-06 21:02:39')).toBe(65)
    expect(revisionAt('2026-11-06 19:00:00')).toBe(64)
    expect(revisionAt('2026-11-03 00:00:00')).toBe(63)
    expect(revisionAt('2026-10-26 00:00:00')).toBe(62)
    expect(revisionAt('2026-10-13 12:00:00')).toBe(61)
    expect(revisionAt('2026-09-30 12:00:00')).toBe(PARSER_REVISION_BEFORE_V6)
  })

  it('the backfill is one mutation that touches only rows still at revision 0, so a second run changes nothing', () => {
    const sql = revisionBackfillSql()
    expect(sql).toMatch(/^ALTER TABLE ulp\.sources UPDATE parser_revision = multiIf\(/)
    expect(sql).toContain('WHERE parser_revision = 0')
    expect(sql).toContain("imported_at >= toDateTime('2026-11-06 20:05:00', 'UTC'), 65")
    expect(sql).toContain(`, ${PARSER_REVISION_BEFORE_V6}) WHERE`)
    expect(sql).toContain('mutations_sync = 2')
  })

  it('recognises a re-feed name by the word, in any case and anywhere', () => {
    expect(isRefeedName('x (refeed v6.5).txt')).toBe(true)
    expect(isRefeedName('REFEED x.txt')).toBe(true)
    expect(isRefeedName('x.txt')).toBe(false)
  })
})
