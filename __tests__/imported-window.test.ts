import { describe, test, expect } from 'vitest'
import {
  WINDOW_PRESETS, startOfLocalDay, presetEpochs, epochsToLocalInputs, localInputToEpoch, checkLocalWindow,
  pillLabel, windowSentence, readWindowFromSearch, writeWindowToSearch, jobViewHref, jobViewLink, type OffsetAt,
} from '@/lib/imported-window'
import { parseImportedRange } from '@/lib/imported-range'

// Minutes the local clock is BEHIND UTC at an instant (Date#getTimezoneOffset). Injected, so no test depends on the machine's zone.
const UTC: OffsetAt = () => 0
const CDT: OffsetAt = () => 300 // UTC-5 all year
// America/Chicago in 2026: UTC-6 until 2026-03-08 08:00Z, UTC-5 until 2026-11-01 07:00Z, UTC-6 after.
const CHICAGO: OffsetAt = ms => (ms >= Date.UTC(2026, 2, 8, 8) && ms < Date.UTC(2026, 10, 1, 7) ? 300 : 360)

const z = (s: string) => Date.parse(s) / 1000 // epoch seconds of a UTC instant

describe('startOfLocalDay', () => {
  test('is local midnight, as an instant', () => {
    expect(startOfLocalDay(Date.parse('2026-10-18T16:55:00Z'), CDT)).toBe(Date.parse('2026-10-18T05:00:00Z'))
    expect(startOfLocalDay(Date.parse('2026-10-18T03:00:00Z'), CDT)).toBe(Date.parse('2026-10-17T05:00:00Z')) // 22:00 on the 17th, local
    expect(startOfLocalDay(Date.parse('2026-10-18T16:55:00Z'), UTC)).toBe(Date.parse('2026-10-18T00:00:00Z'))
  })

  test('survives the day the clocks change (midnight is still CST on the spring-forward day)', () => {
    expect(startOfLocalDay(Date.parse('2026-03-08T20:00:00Z'), CHICAGO)).toBe(Date.parse('2026-03-08T06:00:00Z'))
    expect(startOfLocalDay(Date.parse('2026-03-09T20:00:00Z'), CHICAGO)).toBe(Date.parse('2026-03-09T05:00:00Z')) // the day after is 23 h later, not 24
  })
})

describe('presets', () => {
  const NOW = Date.parse('2026-10-18T16:55:30.700Z')

  test('the list is what the popover shows, in order', () => {
    expect(WINDOW_PRESETS.map(p => p.key)).toEqual(['today', 'yesterday', 'last-24h', 'last-7d', 'last-30d'])
  })

  test('the rolling presets count back from now and leave the top open', () => {
    expect(presetEpochs('last-24h', NOW, CDT)).toEqual({ lower: z('2026-10-17T16:55:30Z'), upper: null })
    expect(presetEpochs('last-7d', NOW, CDT)).toEqual({ lower: z('2026-10-11T16:55:30Z'), upper: null })
    expect(presetEpochs('last-30d', NOW, CDT)).toEqual({ lower: z('2026-09-18T16:55:30Z'), upper: null })
  })

  test('Today keeps the first second of the day: the exclusive lower bound is midnight minus one second', () => {
    expect(presetEpochs('today', NOW, CDT)).toEqual({ lower: z('2026-10-18T04:59:59Z'), upper: null })
  })

  test('Yesterday is a closed window of exactly that calendar day: (midnight - 1 s, next midnight - 1 s]', () => {
    expect(presetEpochs('yesterday', NOW, CDT)).toEqual({ lower: z('2026-10-17T04:59:59Z'), upper: z('2026-10-18T04:59:59Z') })
    // chained windows never overlap and never leave a gap: yesterday's upper bound is today's lower bound
    expect(presetEpochs('yesterday', NOW, CDT).upper).toBe(presetEpochs('today', NOW, CDT).lower)
  })

  test('Yesterday on the day after spring-forward is 24 h of wall clock, 23 h of seconds', () => {
    const w = presetEpochs('yesterday', Date.parse('2026-03-09T20:00:00Z'), CHICAGO)
    expect(w).toEqual({ lower: z('2026-03-08T05:59:59Z'), upper: z('2026-03-09T04:59:59Z') })
    expect((w.upper! - w.lower!) / 3600).toBe(23)
  })
})

describe('local date-time text <-> instants', () => {
  test('a datetime-local value is read as local time', () => {
    expect(localInputToEpoch('2026-10-18T11:55', CDT)).toBe(z('2026-10-18T16:55:00Z'))
    expect(localInputToEpoch('2026-10-18T11:55:07', CDT)).toBe(z('2026-10-18T16:55:07Z'))
    expect(localInputToEpoch('2026-10-18T11:55', UTC)).toBe(z('2026-10-18T11:55:00Z'))
  })

  test('the offset is the one in force at that wall time, also across a change', () => {
    expect(localInputToEpoch('2026-03-08T01:30', CHICAGO)).toBe(z('2026-03-08T07:30:00Z')) // CST
    expect(localInputToEpoch('2026-03-08T12:00', CHICAGO)).toBe(z('2026-03-08T17:00:00Z')) // CDT
  })

  test.each(['', '   ', '2026-02-30T10:00', '2026-10-18T25:00', '2026-10-18', 'yesterday', '2026-10-18T11:55:61'])('%j is no time', v => {
    expect(localInputToEpoch(v, CDT)).toBeNull()
  })

  test('epochs go back to the text a datetime-local input shows', () => {
    const inputs = epochsToLocalInputs({ lower: z('2026-10-17T04:59:59Z'), upper: z('2026-10-18T16:55:00Z') }, CDT)
    expect(inputs).toEqual({ after: '2026-10-16T23:59:59', before: '2026-10-18T11:55:00' })
    expect(epochsToLocalInputs({ lower: null, upper: null }, CDT)).toEqual({ after: '', before: '' })
    // the round trip is exact, DST included
    for (const text of ['2026-03-08T01:30:00', '2026-03-08T12:00:00', '2026-11-01T00:30:00', '2026-11-02T09:15:42']) {
      const epoch = localInputToEpoch(text, CHICAGO)!
      expect(epochsToLocalInputs({ lower: epoch, upper: null }, CHICAGO).after).toBe(text)
    }
  })
})

describe('checkLocalWindow', () => {
  test('an open or one-sided window is fine', () => {
    expect(checkLocalWindow('', '', CDT)).toEqual({ ok: true })
    expect(checkLocalWindow('2026-10-18T11:55', '', CDT)).toEqual({ ok: true })
    expect(checkLocalWindow('', '2026-10-18T11:55', CDT)).toEqual({ ok: true })
  })

  test('before must be later than after (the window is (after, before])', () => {
    expect(checkLocalWindow('2026-10-18T11:55', '2026-10-18T12:00', CDT)).toEqual({ ok: true })
    for (const [a, b] of [['2026-10-18T12:00', '2026-10-18T11:55'], ['2026-10-18T12:00', '2026-10-18T12:00']]) {
      const r = checkLocalWindow(a, b, CDT)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.reason).toContain('later than')
    }
  })

  test('a value that is not a time, or outside what ClickHouse stores, is refused with the field named', () => {
    const bad = checkLocalWindow('2026-02-30T10:00', '', CDT)
    expect(bad.ok === false && bad.reason).toContain('Imported after')
    const old = checkLocalWindow('', '1969-12-31T23:00', UTC)
    expect(old.ok === false && old.reason).toContain('Imported before')
    expect(old.ok === false && old.reason).toContain('1970')
  })
})

describe('labels', () => {
  const YEAR = 2026

  test('nothing is set', () => {
    expect(pillLabel({ after: '', before: '', preset: null }, YEAR)).toBe('Imported: any time')
  })

  test('a preset keeps its name', () => {
    expect(pillLabel({ after: '2026-10-17T11:55:30', before: '', preset: 'last-24h' }, YEAR)).toBe('Imported: last 24 h')
    expect(pillLabel({ after: '2026-10-16T23:59:59', before: '2026-10-17T23:59:59', preset: 'yesterday' }, YEAR)).toBe('Imported: yesterday')
    expect(pillLabel({ after: '2026-10-11T11:00:00', before: '2026-10-12T11:00:00', preset: 'since-last-export' }, YEAR)).toBe('Imported: since last export')
  })

  test('typed values show in local time, seconds only when they matter, the year only when it is not this one', () => {
    expect(pillLabel({ after: '2026-10-17T00:00:00', before: '2026-10-18T11:55:00', preset: null }, YEAR)).toBe('Imported: Oct 17 00:00 → Oct 18 11:55')
    expect(pillLabel({ after: '2026-10-16T23:59:59', before: '', preset: null }, YEAR)).toBe('Imported: after Oct 16 23:59:59')
    expect(pillLabel({ after: '', before: '2026-10-18T11:55:00', preset: null }, YEAR)).toBe('Imported: before Oct 18 11:55')
    expect(pillLabel({ after: '2025-12-31T23:00:00', before: '2026-01-02T00:00:00', preset: null }, YEAR)).toBe('Imported: Dec 31 2025 23:00 → Jan 2 00:00')
  })

  test('the sentence under the results says what is shown and which instants the server uses', () => {
    expect(windowSentence({ after: '2026-10-18T11:55:00', before: '' }, CDT)).toEqual({
      text: 'added after 2026-10-18 11:55:00 (your time)',
      utc: '2026-10-18 16:55:00 UTC',
    })
    expect(windowSentence({ after: '2026-10-17T11:00:00', before: '2026-10-18T11:55:00' }, CDT)).toEqual({
      text: 'added after 2026-10-17 11:00:00 and up to 2026-10-18 11:55:00 (your time)',
      utc: '2026-10-17 16:00:00 UTC to 2026-10-18 16:55:00 UTC',
    })
    expect(windowSentence({ after: '', before: '2026-10-18T11:55:00' }, CDT)).toEqual({
      text: 'added up to 2026-10-18 11:55:00 (your time)',
      utc: '2026-10-18 16:55:00 UTC',
    })
    expect(windowSentence({ after: '', before: '' }, CDT)).toBeNull()
  })
})

describe('the page address', () => {
  test('imported_after / imported_before / source_file are read, and the instants become local input values', () => {
    const r = readWindowFromSearch('?imported_after=2026-10-17T16:55:00Z&imported_before=2026-10-18T20:30:15%2B00:00&source_file=a%20b%20%F0%9F%9B%B8.txt', CDT)
    expect(r).toEqual({ after: '2026-10-17T11:55:00', before: '2026-10-18T15:30:15', sourceFile: 'a b 🛸.txt', invalid: [] })
  })

  test('a bare date means what it means to the API: after keeps the whole day, before ends at 23:59:59', () => {
    const r = readWindowFromSearch('imported_after=2026-10-17&imported_before=2026-10-18', UTC) // no leading ?
    expect(r.after).toBe('2026-10-16T23:59:59')
    expect(r.before).toBe('2026-10-18T23:59:59')
  })

  test('values the API would refuse are dropped and named', () => {
    const r = readWindowFromSearch('?imported_after=yesterday&imported_before=2026-02-30', UTC)
    expect(r).toEqual({ after: '', before: '', sourceFile: '', invalid: ['imported_after', 'imported_before'] })
  })

  test('nothing in the address is an open window', () => {
    expect(readWindowFromSearch('', UTC)).toEqual({ after: '', before: '', sourceFile: '', invalid: [] })
    expect(readWindowFromSearch('?foo=1', UTC)).toEqual({ after: '', before: '', sourceFile: '', invalid: [] })
  })

  test('the client reader agrees with the server parser on a table of inputs', () => {
    const inputs = [
      '2026-10-05', '2026-10-05 14:37:00', '2026-10-05T14:37:00Z', '2026-10-05T14:37:00-05:00', '2026-10-05T14:37:00.250+0530',
      '1970-01-01', '2106-02-07', '2106-02-08', '1969-12-31', '2026-13-01', '2026-02-30', '2026-10-05T25:00:00Z', 'tomorrow', '12345',
    ]
    for (const text of inputs) {
      const server = parseImportedRange({ imported_after: text, imported_before: text })
      const client = readWindowFromSearch(`?imported_after=${encodeURIComponent(text)}&imported_before=${encodeURIComponent(text)}`, UTC)
      if (!server.ok) {
        expect(client.invalid, text).toEqual(['imported_after', 'imported_before'])
        continue
      }
      expect(client.invalid, text).toEqual([])
      const back = server.range
      expect(client.after === '' ? null : localInputToEpoch(client.after, UTC), text).toBe(back.lower)
      expect(client.before === '' ? null : localInputToEpoch(client.before, UTC), text).toBe(back.upper)
    }
  })

  test('writing sets or removes only the three managed parameters and keeps everything else, in place', () => {
    expect(writeWindowToSearch('', { afterIso: '2026-10-17T16:55:00Z', beforeIso: null, sourceFile: null })).toBe('?imported_after=2026-10-17T16%3A55%3A00Z')
    expect(writeWindowToSearch('?tab=2&imported_after=old&imported_before=old', { afterIso: '2026-10-17T16:55:00Z', beforeIso: null, sourceFile: 'x y.txt' }))
      .toBe('?tab=2&imported_after=2026-10-17T16%3A55%3A00Z&source_file=x+y.txt')
    expect(writeWindowToSearch('?imported_after=old&source_file=f.txt', { afterIso: null, beforeIso: null, sourceFile: null })).toBe('')
    expect(writeWindowToSearch('?tab=2&imported_after=old', { afterIso: null, beforeIso: null, sourceFile: null })).toBe('?tab=2')
  })

  test('what is written reads back the same', () => {
    const search = writeWindowToSearch('', { afterIso: '2026-10-17T16:55:00Z', beforeIso: '2026-10-18T20:30:15Z', sourceFile: '🛸 Oct #1.txt' })
    expect(readWindowFromSearch(search, CDT)).toEqual({ after: '2026-10-17T11:55:00', before: '2026-10-18T15:30:15', sourceFile: '🛸 Oct #1.txt', invalid: [] })
  })
})

describe('jobViewHref: "View what this added"', () => {
  const job = { filename: 'batch one.txt', status: 'done', imported: 594_542, duration_ms: 33_481, created_at: '2026-10-18 16:55:17' }
  const params = (href: string | null) => Object.fromEntries(new URL(href!, 'http://x').searchParams)

  test('opens the Credentials page on the job window and file', () => {
    const href = jobViewHref(job)!
    expect(href.startsWith('/credentials?')).toBe(true)
    // end 16:55:17 (to the second) - 33.481 s = 16:54:43.519 -> second 16:54:43, minus 1 s because the lower bound is exclusive; end + 1 s
    expect(params(href)).toEqual({ imported_after: '2026-10-18T16:54:42Z', imported_before: '2026-10-18T16:55:18Z', source_file: 'batch one.txt' })
  })

  test('an archive reference pins the ORIGINAL file name (its rows carry that name); a ZIP or any other name gets the window only', () => {
    expect(params(jobViewHref({ ...job, filename: 'x y.txt.archiveref' }))).toHaveProperty('source_file', 'x y.txt')
    expect(params(jobViewHref({ ...job, filename: 'UPPER.CSV.ARCHIVEREF' }))).toHaveProperty('source_file', 'UPPER.CSV')
    expect(params(jobViewHref({ ...job, filename: 'UPPER.CSV' }))).toHaveProperty('source_file', 'UPPER.CSV')
    for (const filename of ['pack.zip', 'x.zip.archiveref', 'dump', 'a.TXT.gz', '.archiveref']) {
      expect(params(jobViewHref({ ...job, filename })), filename).not.toHaveProperty('source_file')
    }
  })

  test('the link is exact when the file pins it, and says so when only the window does (the queue can run jobs side by side)', () => {
    expect(jobViewLink(job)!.exact).toBe(true)
    expect(jobViewLink({ ...job, filename: 'x.txt.archiveref' })!.exact).toBe(true)
    expect(jobViewLink({ ...job, filename: 'pack.zip' })!.exact).toBe(false)
    expect(jobViewLink({ ...job, filename: 'pack.zip' })!.href).toBe(jobViewHref({ ...job, filename: 'pack.zip' }))
  })

  test('only a finished job that added rows has something to view', () => {
    expect(jobViewHref({ ...job, imported: 0 })).toBeNull()
    expect(jobViewHref({ ...job, status: 'failed' })).toBeNull()
    expect(jobViewHref({ ...job, status: 'held' })).toBeNull()
    expect(jobViewHref({ ...job, created_at: 'not a time' })).toBeNull()
    expect(jobViewHref({ ...job, duration_ms: Number.NaN })).toBeNull()
  })

  test('the page can read the link back', () => {
    const href = jobViewHref({ ...job, filename: '🛸 Oct - @A - #1647 by @b.txt' })!
    const r = readWindowFromSearch(href.slice(href.indexOf('?')), UTC)
    expect(r).toEqual({ after: '2026-10-18T16:54:42', before: '2026-10-18T16:55:18', sourceFile: '🛸 Oct - @A - #1647 by @b.txt', invalid: [] })
  })
})
