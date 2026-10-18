import { describe, test, expect, beforeEach } from 'vitest'
import { dbGet, dbRun } from '@/lib/sqlite'
import {
  STATS_MARKER_KEY,
  clearStatsMarker,
  loadStatsMarker,
  parseStatsMarker,
  saveStatsMarker,
  type StatsMarker,
} from '@/lib/dedup-stats-marker'

const now = 1_800_000_000_000
const good: StatsMarker = { rows: 1_844_470_188, total: 1_844_470_188, excess: 0, at: now - 3_600_000 }

describe('parseStatsMarker', () => {
  test('reads exactly what was written', () => {
    expect(parseStatsMarker(JSON.stringify(good), now)).toEqual(good)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['text that is not JSON', 'nope'],
    ['a JSON array', '[]'],
    ['an empty object', '{}'],
    ['a negative row count', JSON.stringify({ ...good, rows: -1 })],
    ['a row count that is a string', JSON.stringify({ ...good, rows: '1844470188' })],
    ['a null excess', JSON.stringify({ ...good, excess: null })],
    ['a missing timestamp', JSON.stringify({ rows: good.rows, total: good.total, excess: good.excess })],
  ])('rejects %s, so a damaged value costs one pass and never a wrong skip', (_name, raw) => {
    expect(parseStatsMarker(raw, now)).toBeNull()
  })

  test('rejects a marker timestamped in the future: it would skip every pass until that moment', () => {
    expect(parseStatsMarker(JSON.stringify({ ...good, at: now + 3_600_000 }), now)).toBeNull()
  })

  test('accepts a marker within the clock-skew allowance', () => {
    const slightlyAhead = { ...good, at: now + 30_000 }
    expect(parseStatsMarker(JSON.stringify(slightlyAhead), now)).toEqual(slightlyAhead)
  })
})

describe('the stored marker (the real SQLite test database)', () => {
  beforeEach(() => clearStatsMarker())

  test('loads nothing before anything was saved', () => {
    expect(loadStatsMarker(now)).toBeNull()
  })

  test('save then load round-trips', () => {
    saveStatsMarker(good)
    expect(loadStatsMarker(now)).toEqual(good)
  })

  test('a second save replaces the first', () => {
    saveStatsMarker(good)
    saveStatsMarker({ ...good, rows: good.rows + 5, at: good.at + 1000 })
    expect(loadStatsMarker(now)?.rows).toBe(good.rows + 5)
    expect(dbGet(`SELECT count(*) AS n FROM app_settings WHERE key_name = ?`, [STATS_MARKER_KEY])).toEqual({ n: 1 })
  })

  test('clear removes it', () => {
    saveStatsMarker(good)
    clearStatsMarker()
    expect(loadStatsMarker(now)).toBeNull()
  })

  test('a damaged stored value reads as nothing and never throws', () => {
    dbRun(`INSERT OR REPLACE INTO app_settings (key_name, value) VALUES (?, ?)`, [STATS_MARKER_KEY, 'garbage'])
    expect(loadStatsMarker(now)).toBeNull()
  })
})
