import { describe, test, expect, vi, afterEach } from 'vitest'
import { SITE_COUNTS_MAX_PER_LIST, siteEntry } from '@/lib/site-counts-input'
import {
  MARK_FILTERS,
  MARK_FILTER_LABELS,
  NO_MARK_LABEL,
  SITE_MARKS_MAX_HOSTS,
  SITE_MARK_LABELS,
  SITE_MARK_NOTE_MAX,
  SITE_MARK_STATUSES,
  checkMarkPatch,
  isMarkableHost,
  markAriaLabel,
  markFilterCounts,
  markRank,
  markStateOf,
  markTitle,
  matchesMarkFilter,
  mergeMark,
  normalizeNote,
  type MarkState,
  type SiteMark,
} from '@/lib/site-marks-input'

const mark = (status: SiteMark['status'], note: string | null = null, by: string | null = 'a@example.test', at: string | null = '2026-10-29 10:00:00'): SiteMark => ({
  status, note, updated_by: by, updated_at: at,
})

afterEach(() => vi.useRealTimers())

describe('the statuses', () => {
  test('are done, skip and to look at, in the order the menu lists them, each with a label', () => {
    expect([...SITE_MARK_STATUSES]).toEqual(['done', 'skip', 'todo'])
    expect(SITE_MARK_LABELS).toEqual({ done: 'Done', skip: 'Skip', todo: 'To look at' })
    expect(NO_MARK_LABEL).toBe('No mark')
  })

  test('a note is capped at 500 characters, and a read takes as many hosts as a list may hold', () => {
    expect(SITE_MARK_NOTE_MAX).toBe(500)
    expect(SITE_MARKS_MAX_HOSTS).toBe(SITE_COUNTS_MAX_PER_LIST)
    expect(SITE_MARKS_MAX_HOSTS).toBe(2000)
  })

  test('the filter chips are All, the three statuses, then No mark', () => {
    expect([...MARK_FILTERS]).toEqual(['all', 'done', 'skip', 'todo', 'none'])
    expect(MARK_FILTER_LABELS).toEqual({ all: 'All', done: 'Done', skip: 'Skip', todo: 'To look at', none: 'No mark' })
  })
})

describe('isMarkableHost — the key a mark is kept under', () => {
  test('is a host the cleaning leaves as it is', () => {
    expect(isMarkableHost('corp.example')).toBe(true)
    expect(isMarkableHost('app.corp.example')).toBe(true)
  })

  test('is not text with no host, or a host as it was typed', () => {
    for (const typed of ['', 'localhost', 'https://www.corp.example/login', 'www.corp.example', '*.corp.example', 'Corp.Example', 'corp.example:8443']) {
      expect(isMarkableHost(typed)).toBe(false)
    }
  })

  test('every spelling of a site the counts clean to one host gives a host that can be marked, the same one', () => {
    const spellings = ['corp.example', 'https://www.corp.example/login', '*.corp.example', 'HTTP://WWW.Corp.Example:8443/a?b=1#c', '.corp.example', 'www.www.corp.example', '*.www.corp.example']
    const hosts = spellings.map(s => siteEntry(s).host)
    expect(new Set(hosts)).toEqual(new Set(['corp.example']))
    expect(hosts.every(isMarkableHost)).toBe(true)
  })

  test('three leading www. is the one shape the cleaning still changes on a second pass: such a host cannot be marked', () => {
    expect(isMarkableHost(siteEntry('www.www.corp.example').host)).toBe(true)
    expect(siteEntry('www.www.www.corp.example').host).toBe('www.corp.example')
    expect(isMarkableHost(siteEntry('www.www.www.corp.example').host)).toBe(false)
  })
})

describe('normalizeNote', () => {
  test('trims, and nothing left is null', () => {
    expect(normalizeNote('  looked at it  ')).toBe('looked at it')
    expect(normalizeNote('')).toBeNull()
    expect(normalizeNote('   \n\t ')).toBeNull()
    expect(normalizeNote(null)).toBeNull()
    expect(normalizeNote(undefined)).toBeNull()
  })

  test('keeps the line breaks inside a note', () => {
    expect(normalizeNote(' first\nsecond ')).toBe('first\nsecond')
  })
})

describe('checkMarkPatch — what a PUT body asks for', () => {
  test('a status alone, a note alone, or both; the host in the body is not part of the patch', () => {
    expect(checkMarkPatch({ host: 'corp.example', status: 'done' })).toEqual({ ok: true, patch: { status: 'done' } })
    expect(checkMarkPatch({ note: '  checked  ' })).toEqual({ ok: true, patch: { note: 'checked' } })
    expect(checkMarkPatch({ status: 'todo', note: 'later' })).toEqual({ ok: true, patch: { status: 'todo', note: 'later' } })
  })

  test('null clears a field, and an empty or blank note is null', () => {
    expect(checkMarkPatch({ status: null })).toEqual({ ok: true, patch: { status: null } })
    expect(checkMarkPatch({ note: null })).toEqual({ ok: true, patch: { note: null } })
    expect(checkMarkPatch({ note: '' })).toEqual({ ok: true, patch: { note: null } })
    expect(checkMarkPatch({ note: '   ' })).toEqual({ ok: true, patch: { note: null } })
  })

  test('with neither field it is refused, and an undefined field counts as absent', () => {
    expect(checkMarkPatch({})).toEqual({ ok: false, error: 'Send a status, a note or both' })
    expect(checkMarkPatch({ host: 'corp.example' })).toEqual({ ok: false, error: 'Send a status, a note or both' })
    expect(checkMarkPatch({ status: undefined, note: undefined })).toEqual({ ok: false, error: 'Send a status, a note or both' })
  })

  test('a status outside the list, and a note that is not text, are refused', () => {
    expect(checkMarkPatch({ status: 'finished' })).toEqual({ ok: false, error: 'status must be one of done, skip, todo, or null' })
    expect(checkMarkPatch({ status: 3 })).toMatchObject({ ok: false })
    expect(checkMarkPatch({ status: '' })).toMatchObject({ ok: false })
    expect(checkMarkPatch({ note: 5 })).toEqual({ ok: false, error: 'note must be text, or null' })
  })

  test('a note of 500 characters is kept, 501 is refused, and the cap counts what is left after trimming', () => {
    expect(checkMarkPatch({ note: 'x'.repeat(500) })).toMatchObject({ ok: true })
    expect(checkMarkPatch({ note: 'x'.repeat(501) })).toEqual({ ok: false, error: 'note is at most 500 characters' })
    expect(checkMarkPatch({ note: ` ${'x'.repeat(500)} ` })).toMatchObject({ ok: true })
  })
})

describe('mergeMark — a mark after a change', () => {
  test('a status on a site with no mark', () => {
    expect(mergeMark(null, { status: 'done' })).toEqual({ status: 'done', note: null })
  })

  test('a field left out keeps its value, so a status change keeps the note and a note change keeps the status', () => {
    expect(mergeMark({ status: 'done', note: 'a' }, { status: 'skip' })).toEqual({ status: 'skip', note: 'a' })
    expect(mergeMark({ status: 'done', note: 'a' }, { note: 'b' })).toEqual({ status: 'done', note: 'b' })
  })

  test('null clears a field and a blank note clears the note', () => {
    expect(mergeMark({ status: 'done', note: 'a' }, { note: null })).toEqual({ status: 'done', note: null })
    expect(mergeMark({ status: null, note: 'a' }, { note: '  ' })).toBeNull()
  })

  test('a note alone is a mark with no status, and a status can be added to it', () => {
    expect(mergeMark(null, { note: 'only a note' })).toEqual({ status: null, note: 'only a note' })
    expect(mergeMark({ status: null, note: 'a' }, { status: 'todo' })).toEqual({ status: 'todo', note: 'a' })
  })

  test('with neither a status nor a note left there is no mark', () => {
    expect(mergeMark({ status: 'done', note: null }, { status: null })).toBeNull()
    expect(mergeMark({ status: 'done', note: 'a' }, { status: null, note: null })).toBeNull()
    expect(mergeMark(null, {})).toBeNull()
  })

  test('the note is stored trimmed', () => {
    expect(mergeMark(null, { note: '  x ' })).toEqual({ status: null, note: 'x' })
  })
})

describe('markStateOf — what a row can show', () => {
  const marks = { 'a.example': mark('done'), 'b.example': mark(null, 'a note only'), 'c.example': mark('todo', 'and a note') }

  test('a status, or none for a site that can be marked and has no status (a note alone is not a mark)', () => {
    expect(markStateOf('a.example', marks, true)).toBe('done')
    expect(markStateOf('c.example', marks, true)).toBe('todo')
    expect(markStateOf('b.example', marks, true)).toBe('none')
    expect(markStateOf('d.example', marks, true)).toBe('none')
  })

  test('null when the marks are not loaded: never none, or a person could save over a note they cannot see', () => {
    expect(markStateOf('a.example', marks, false)).toBeNull()
    expect(markStateOf('d.example', {}, false)).toBeNull()
  })

  test('null for a row with no host, and for a host that cannot be marked', () => {
    expect(markStateOf('', marks, true)).toBeNull()
    expect(markStateOf('localhost', marks, true)).toBeNull()
    expect(markStateOf('www.corp.example', marks, true)).toBeNull()
  })
})

describe('markRank — the order of the Mark column', () => {
  test('to look at first, then no mark, then done, then skip', () => {
    expect((['todo', 'none', 'done', 'skip'] as const).map(markRank)).toEqual([3, 2, 1, 0])
  })

  test('a row that cannot show a mark has no rank', () => {
    expect(markRank(null)).toBeNull()
  })
})

describe('matchesMarkFilter and markFilterCounts — the chips', () => {
  const states: MarkState[] = ['done', 'done', 'skip', 'todo', 'none', 'none', 'none', null]

  test('All shows every row, one that cannot show a mark included; the others show their own state only', () => {
    expect(states.filter(s => matchesMarkFilter(s, 'all'))).toHaveLength(8)
    expect(states.filter(s => matchesMarkFilter(s, 'done'))).toEqual(['done', 'done'])
    expect(states.filter(s => matchesMarkFilter(s, 'skip'))).toEqual(['skip'])
    expect(states.filter(s => matchesMarkFilter(s, 'todo'))).toEqual(['todo'])
    expect(states.filter(s => matchesMarkFilter(s, 'none'))).toEqual(['none', 'none', 'none'])
  })

  test('No mark never takes a row that cannot show a mark', () => {
    expect(matchesMarkFilter(null, 'none')).toBe(false)
    expect(matchesMarkFilter(null, 'done')).toBe(false)
    expect(matchesMarkFilter(null, 'all')).toBe(true)
  })

  test('each chip counts the rows it would show', () => {
    expect(markFilterCounts(states)).toEqual({ all: 8, done: 2, skip: 1, todo: 1, none: 3 })
    expect(markFilterCounts([])).toEqual({ all: 0, done: 0, skip: 0, todo: 0, none: 0 })
  })
})

describe('markTitle and markAriaLabel — the words of a cell', () => {
  test('a site with no mark says so', () => {
    expect(markTitle(null)).toBe('No mark')
    expect(markAriaLabel('corp.example', null)).toBe('Mark for corp.example: No mark')
  })

  test('the label, the note and who set it, with the time relative to now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
    expect(markTitle(mark('skip', 'dead company'))).toBe('Skip\ndead company\na@example.test, 2 hours ago')
    expect(markAriaLabel('corp.example', mark('skip', 'dead company'))).toBe('Mark for corp.example: Skip, has a note')
  })

  test('a note longer than 200 characters is cut in the tooltip', () => {
    const title = markTitle(mark('done', 'n'.repeat(300), null, null))
    expect(title.split('\n')[1]).toBe(`${'n'.repeat(200)}…`)
  })

  test('a mark whose change the server has not answered yet has no who and when', () => {
    expect(markTitle(mark('todo', null, null, null))).toBe('To look at')
  })
})
