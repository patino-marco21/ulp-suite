import { describe, test, expect } from 'vitest'
import {
  EXPORT_CUT_LAG_SECONDS, epochSecondsToIso, localInputToUtcIso, utcEpochToLocalInput, utcIsoToDisplay,
  searchFingerprint, readMark, writeMark, markStorageKey, sinceLastExportWindow, markAfterExport, IMPORTED_PRESETS,
  type ExportMark,
} from '@/lib/imported-range-client'

const T = Date.UTC(2026, 9, 5, 19, 37, 0) / 1000 // 2026-10-05T19:37:00Z
const NOW_MS = (T + 3600) * 1000

describe('local date-time input <-> UTC instant', () => {
  test('UTC-5 (offset 300): 14:37 local is 19:37 UTC', () => {
    expect(localInputToUtcIso('2026-10-05T14:37', 300)).toBe('2026-10-05T19:37:00Z')
    expect(localInputToUtcIso('2026-10-05T14:37:15', 300)).toBe('2026-10-05T19:37:15Z')
  })

  test('UTC+2 (offset -120) and UTC (offset 0)', () => {
    expect(localInputToUtcIso('2026-10-05T21:37', -120)).toBe('2026-10-05T19:37:00Z')
    expect(localInputToUtcIso('2026-10-05T19:37', 0)).toBe('2026-10-05T19:37:00Z')
  })

  test('crossing midnight in either direction', () => {
    expect(localInputToUtcIso('2026-10-05T22:30', 300)).toBe('2026-10-06T03:30:00Z')
    expect(localInputToUtcIso('2026-10-06T01:30', -120)).toBe('2026-10-05T23:30:00Z')
  })

  test.each(['', 'x', '2026-10-05', '2026-10-05T14', '2026-02-30T10:00', '2026-10-05T24:00', '2026-10-05T14:60', '2026-10-05T14:37:60'])(
    'an empty or impossible value is null: %j', value => {
      expect(localInputToUtcIso(value, 300)).toBeNull()
    },
  )

  test('the reverse conversion fills an input in local time', () => {
    expect(utcEpochToLocalInput(T, 300)).toBe('2026-10-05T14:37:00')
    expect(utcEpochToLocalInput(T, -120)).toBe('2026-10-05T21:37:00')
  })

  test('the two directions round-trip', () => {
    for (const offset of [300, 0, -120, -330]) {
      const local = utcEpochToLocalInput(T, offset)
      expect(localInputToUtcIso(local, offset)).toBe(epochSecondsToIso(T))
    }
  })

  test('the UTC echo shown beside an input', () => {
    expect(utcIsoToDisplay('2026-10-05T19:37:00Z')).toBe('2026-10-05 19:37:00 UTC')
  })
})

describe('searchFingerprint — the same search gets the same key, whatever the date, sort or order of the fields', () => {
  test('is stable and ignores empty values', () => {
    const a = searchFingerprint({ q: 'term', domain: '', tierInclude: [], dedupe: true, excludeNoise: false })
    const b = searchFingerprint({ excludeNoise: false, dedupe: true, tierInclude: [], domain: '', q: 'term', unused: undefined })
    expect(a).toBe(b)
  })

  test('differs when any narrowing field differs', () => {
    const base = { q: 'term', domain: '', tierInclude: ['T1'] }
    expect(searchFingerprint(base)).not.toBe(searchFingerprint({ ...base, q: 'term2' }))
    expect(searchFingerprint(base)).not.toBe(searchFingerprint({ ...base, tierInclude: ['T2'] }))
    expect(searchFingerprint(base)).not.toBe(searchFingerprint({ ...base, domain: 'x.example' }))
  })

  test('a list and a string of the same text are the same field value', () => {
    expect(searchFingerprint({ tiers: ['T1', 'T2'] })).toBe(searchFingerprint({ tiers: 'T1,T2' }))
  })

  test('is safe as a storage key suffix', () => {
    expect(markStorageKey(searchFingerprint({ q: 'a b&c=d' }))).toMatch(/^ulp:last-export:[0-9a-z]+-[0-9a-z]+$/)
  })
})

describe('the remembered mark survives only when it is well formed', () => {
  const mark: ExportMark = { through: T, rows: 12, at: 1 }

  test('round trip', () => {
    const store = new Map<string, string>()
    writeMark({ setItem: (k, v) => void store.set(k, v) }, 'k', mark)
    expect(readMark({ getItem: k => store.get(k) ?? null }, 'k')).toEqual(mark)
  })

  test.each([[null], [undefined]])('no storage at all reads as nothing remembered: %s', storage => {
    expect(readMark(storage, 'k')).toBeNull()
    expect(() => writeMark(storage, 'k', mark)).not.toThrow()
  })

  test('junk, a missing field, a wrong type and a throwing storage all read as nothing remembered', () => {
    const read = (raw: string | null) => readMark({ getItem: () => raw }, 'k')
    expect(read(null)).toBeNull()
    expect(read('')).toBeNull()
    expect(read('not json')).toBeNull()
    expect(read('{"through":"x","rows":1,"at":1}')).toBeNull()
    expect(read('{"through":1}')).toBeNull()
    expect(readMark({ getItem: () => { throw new Error('blocked') } }, 'k')).toBeNull()
  })

  test('a throwing setItem (quota, private window) is swallowed', () => {
    expect(() => writeMark({ setItem: () => { throw new Error('quota') } }, 'k', mark)).not.toThrow()
  })
})

describe('sinceLastExportWindow — (remembered cut, now minus the lag]', () => {
  const mark: ExportMark = { through: T, rows: 5, at: 1 }

  test('nothing remembered', () => {
    expect(sinceLastExportWindow(null, NOW_MS)).toEqual({ ok: false, reason: 'no-mark' })
  })

  test('starts exactly at the remembered cut and ends the lag before now', () => {
    expect(sinceLastExportWindow(mark, NOW_MS)).toEqual({
      ok: true,
      after: epochSecondsToIso(T),
      before: epochSecondsToIso(T + 3600 - EXPORT_CUT_LAG_SECONDS),
    })
  })

  test('asked again inside the lag, the window would be empty or backwards: too soon', () => {
    expect(sinceLastExportWindow(mark, (T + EXPORT_CUT_LAG_SECONDS) * 1000)).toEqual({ ok: false, reason: 'too-soon' })
    expect(sinceLastExportWindow(mark, (T + 10) * 1000)).toEqual({ ok: false, reason: 'too-soon' })
  })
})

describe('markAfterExport — the chain has no gaps', () => {
  const prev: ExportMark = { through: T, rows: 5, at: 1 }
  const complete = { truncated: false, rows: 40 }
  const latestSafe = Math.floor(NOW_MS / 1000) - EXPORT_CUT_LAG_SECONDS

  test('a truncated export never moves the mark', () => {
    expect(markAfterExport(prev, { lower: T, upper: T + 600 }, { truncated: true, rows: 10_000 }, NOW_MS)).toBeNull()
    expect(markAfterExport(null, { lower: null, upper: null }, { truncated: true, rows: 10_000 }, NOW_MS)).toBeNull()
  })

  test('the first export (no lower bound, nothing remembered) records the cut: now minus the lag when no upper bound was sent', () => {
    expect(markAfterExport(null, { lower: null, upper: null }, complete, NOW_MS)).toEqual({ through: latestSafe, rows: 40, at: NOW_MS })
  })

  test('a full export (no lower bound) records its cut even when a mark exists', () => {
    expect(markAfterExport(prev, { lower: null, upper: null }, complete, NOW_MS)?.through).toBe(latestSafe)
  })

  test('the preset export (lower bound equal to the remembered cut) moves the mark to its upper bound', () => {
    expect(markAfterExport(prev, { lower: T, upper: T + 600 }, complete, NOW_MS)).toEqual({ through: T + 600, rows: 40, at: NOW_MS })
  })

  test('a hand-typed lower bound that is not the remembered cut leaves the mark alone', () => {
    expect(markAfterExport(prev, { lower: T + 5, upper: T + 600 }, complete, NOW_MS)).toBeNull()
    expect(markAfterExport(prev, { lower: T - 5, upper: T + 600 }, complete, NOW_MS)).toBeNull()
    expect(markAfterExport(null, { lower: T, upper: T + 600 }, complete, NOW_MS)).toBeNull()
  })

  test('an upper bound in the future, or inside the lag, is clamped to now minus the lag', () => {
    expect(markAfterExport(prev, { lower: T, upper: T + 999_999 }, complete, NOW_MS)?.through).toBe(latestSafe)
    expect(markAfterExport(prev, { lower: T, upper: latestSafe + 30 }, complete, NOW_MS)?.through).toBe(latestSafe)
  })

  test('the mark never moves backwards', () => {
    expect(markAfterExport(prev, { lower: null, upper: T - 1000 }, complete, NOW_MS)).toBeNull()
    expect(markAfterExport(prev, { lower: T, upper: T }, complete, NOW_MS)?.through).toBe(T) // an empty window leaves it where it was
  })
})

describe('presets', () => {
  test('the lower-bound presets, in seconds before now', () => {
    expect(IMPORTED_PRESETS.map(p => [p.key, p.seconds])).toEqual([['last-24h', 86_400], ['last-7d', 604_800]])
  })
})
