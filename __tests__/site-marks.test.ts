import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { dbGet, dbQuery, dbRun } from '@/lib/sqlite'
import { answerMarkChange, answerMarksRead, changeSiteMark, readSiteMarks } from '@/lib/site-marks'

// These run on the real SQLite file of the test worker (see __tests__/setup/), so the SQL itself is what is proven, not a mock of it.
const A = 'a@example.test'
const B = 'b@example.test'
const rowOf = (host: string) => dbGet('SELECT status, note, updated_by, updated_at FROM site_marks WHERE host = ?', [host]) as
  { status: string | null; note: string | null; updated_by: string | null; updated_at: string } | undefined
const count = () => (dbGet('SELECT count(*) AS n FROM site_marks') as { n: number }).n

beforeEach(() => { dbRun('DELETE FROM site_marks') })
afterEach(() => vi.restoreAllMocks())

describe('the site_marks table', () => {
  test('refuses a row with neither a status nor a note, whatever wrote it', () => {
    expect(() => dbRun(`INSERT INTO site_marks (host) VALUES ('corp.example')`)).toThrow(/CHECK constraint/)
    expect(() => dbRun(`INSERT INTO site_marks (host, status, note) VALUES ('corp.example', NULL, NULL)`)).toThrow(/CHECK constraint/)
    expect(count()).toBe(0)
  })

  test('keeps one row per host', () => {
    dbRun(`INSERT INTO site_marks (host, status) VALUES ('corp.example', 'done')`)
    expect(() => dbRun(`INSERT INTO site_marks (host, status) VALUES ('corp.example', 'skip')`)).toThrow(/UNIQUE|PRIMARY KEY/)
  })
})

describe('changeSiteMark', () => {
  test('sets a status alone, and answers with what is stored: who and when in the form SQLite writes UTC', () => {
    const mark = changeSiteMark('corp.example', { status: 'done' }, A)
    expect(mark).toEqual({ status: 'done', note: null, updated_by: A, updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) })
    expect(rowOf('corp.example')).toMatchObject({ status: 'done', note: null, updated_by: A })
  })

  test('sets a note alone, which is a mark with no status', () => {
    expect(changeSiteMark('corp.example', { note: 'login page is behind a captcha' }, A)).toMatchObject({ status: null, note: 'login page is behind a captcha' })
    expect(count()).toBe(1)
  })

  test('a field left out keeps its stored value: a status change keeps the note and a note change keeps the status', () => {
    changeSiteMark('corp.example', { status: 'todo', note: 'first' }, A)
    expect(changeSiteMark('corp.example', { status: 'skip' }, A)).toMatchObject({ status: 'skip', note: 'first' })
    expect(changeSiteMark('corp.example', { note: 'second' }, A)).toMatchObject({ status: 'skip', note: 'second' })
  })

  test('two people changing different fields of one site both keep their change', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    changeSiteMark('corp.example', { note: 'checked twice' }, B)
    expect(rowOf('corp.example')).toMatchObject({ status: 'done', note: 'checked twice', updated_by: B })
  })

  test('null clears a field; a blank note clears the note', () => {
    changeSiteMark('corp.example', { status: 'done', note: 'x' }, A)
    expect(changeSiteMark('corp.example', { note: null }, A)).toMatchObject({ status: 'done', note: null })
    changeSiteMark('corp.example', { note: 'again' }, A)
    expect(changeSiteMark('corp.example', { note: '   ' }, A)).toMatchObject({ status: 'done', note: null })
    expect(changeSiteMark('corp.example', { status: null }, A)).toBeNull()
  })

  test('when neither a status nor a note is left the row is deleted, and the answer is null', () => {
    changeSiteMark('corp.example', { status: 'done', note: 'x' }, A)
    expect(changeSiteMark('corp.example', { status: null, note: null }, A)).toBeNull()
    expect(rowOf('corp.example')).toBeUndefined()
    expect(count()).toBe(0)
  })

  test('clearing what is not there succeeds and writes nothing', () => {
    expect(changeSiteMark('corp.example', { status: null, note: null }, A)).toBeNull()
    expect(count()).toBe(0)
  })

  test('a real change takes over who and when', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    dbRun(`UPDATE site_marks SET updated_at = '2020-01-01 00:00:00' WHERE host = 'corp.example'`)
    const changed = changeSiteMark('corp.example', { status: 'skip' }, B)
    expect(changed).toMatchObject({ status: 'skip', updated_by: B })
    expect(changed?.updated_at).not.toBe('2020-01-01 00:00:00')
  })

  test('a change that leaves the mark as it was writes nothing: the row keeps whoever last really changed it, and when', () => {
    changeSiteMark('corp.example', { status: 'done', note: 'same' }, A)
    dbRun(`UPDATE site_marks SET updated_at = '2020-01-01 00:00:00' WHERE host = 'corp.example'`)
    const again = changeSiteMark('corp.example', { status: 'done', note: '  same ' }, B)
    expect(again).toEqual({ status: 'done', note: 'same', updated_by: A, updated_at: '2020-01-01 00:00:00' })
    expect(rowOf('corp.example')).toMatchObject({ updated_by: A, updated_at: '2020-01-01 00:00:00' })
  })

  test('keeps each site apart', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    changeSiteMark('app.corp.example', { status: 'skip' }, A)
    expect(rowOf('corp.example')?.status).toBe('done')
    expect(rowOf('app.corp.example')?.status).toBe('skip')
  })

  test('no name for who is asking is stored as null', () => {
    expect(changeSiteMark('corp.example', { status: 'done' }, null)).toMatchObject({ updated_by: null })
  })
})

describe('readSiteMarks', () => {
  test('answers only for the hosts that have a mark', () => {
    changeSiteMark('a.example', { status: 'done' }, A)
    changeSiteMark('b.example', { note: 'only a note' }, A)
    const marks = readSiteMarks(['a.example', 'b.example', 'c.example'])
    expect(Object.keys(marks).sort()).toEqual(['a.example', 'b.example'])
    expect(marks['a.example']).toMatchObject({ status: 'done', note: null })
    expect(marks['b.example']).toMatchObject({ status: null, note: 'only a note' })
  })

  test('looks hosts up exactly as given: a spelling the counts would clean is not another name for the site', () => {
    changeSiteMark('corp.example', { status: 'done' }, A)
    expect(readSiteMarks(['https://www.corp.example/login', 'CORP.EXAMPLE', 'www.corp.example'])).toEqual({})
  })

  test('takes a list with repeats, and an empty list', () => {
    changeSiteMark('a.example', { status: 'todo' }, A)
    expect(Object.keys(readSiteMarks(['a.example', 'a.example', 'a.example']))).toEqual(['a.example'])
    expect(readSiteMarks([])).toEqual({})
  })

  test('reads a whole list of 2,000 hosts in one statement', () => {
    changeSiteMark('site0.example', { status: 'done' }, A)
    changeSiteMark('site1999.example', { status: 'skip' }, A)
    const hosts = Array.from({ length: 2000 }, (_, i) => `site${i}.example`)
    const marks = readSiteMarks(hosts)
    expect(Object.keys(marks).sort()).toEqual(['site0.example', 'site1999.example'])
  })

  test('is not fooled by a host written like SQL', () => {
    changeSiteMark('a.example', { status: 'done' }, A)
    expect(readSiteMarks([`x.example' OR '1'='1`])).toEqual({})
    expect(count()).toBe(1)
  })
})

describe('answerMarksRead — POST /api/lookup/marks', () => {
  test('answers 200 with the marks of the hosts asked for', () => {
    changeSiteMark('a.example', { status: 'done', note: 'n' }, A)
    const reply = answerMarksRead({ hosts: ['a.example', 'b.example'] })
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ success: true, marks: { 'a.example': { status: 'done', note: 'n', updated_by: A, updated_at: expect.any(String) } } })
  })

  test('refuses (400) a body that is not an object, no hosts, an empty list, a list that is not text, and more than 2,000', () => {
    for (const body of [null, 'hosts', [], {}, { hosts: 'a.example' }, { hosts: [] }, { hosts: ['a.example', 3] }, { hosts: [null] }]) {
      expect(answerMarksRead(body).status).toBe(400)
    }
    const tooMany = answerMarksRead({ hosts: Array.from({ length: 2001 }, (_, i) => `s${i}.example`) })
    expect(tooMany.status).toBe(400)
    expect(tooMany.json.error).toBe('Too many sites (2001). Maximum is 2000 per request.')
    expect(answerMarksRead({ hosts: Array.from({ length: 2000 }, (_, i) => `s${i}.example`) }).status).toBe(200)
  })

  test('a failure of the database is a 500 for the request, logged, not a quiet empty answer', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    dbRun('ALTER TABLE site_marks RENAME TO site_marks_away')
    try {
      expect(answerMarksRead({ hosts: ['a.example'] })).toEqual({ status: 500, json: { success: false, error: 'Reading the marks failed' } })
      expect(logged).toHaveBeenCalled()
    } finally {
      dbRun('ALTER TABLE site_marks_away RENAME TO site_marks')
    }
  })
})

describe('answerMarkChange — PUT /api/lookup/marks', () => {
  test('answers 200 with the host and the stored mark', () => {
    const reply = answerMarkChange({ host: 'corp.example', status: 'todo', note: ' later ' }, A)
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ success: true, host: 'corp.example', mark: { status: 'todo', note: 'later', updated_by: A, updated_at: expect.any(String) } })
  })

  test('clearing both answers 200 with a null mark, and the row is gone', () => {
    answerMarkChange({ host: 'corp.example', status: 'todo' }, A)
    expect(answerMarkChange({ host: 'corp.example', status: null, note: null }, A)).toEqual({ status: 200, json: { success: true, host: 'corp.example', mark: null } })
    expect(count()).toBe(0)
  })

  test('refuses (400) a body that is not an object, and a host that is missing or is not a site as the counts name it', () => {
    for (const body of [null, 'x', [], {}, { status: 'done' }, { host: 5, status: 'done' }, { host: '', status: 'done' }]) {
      expect(answerMarkChange(body, A).status).toBe(400)
    }
    for (const host of ['https://www.corp.example/login', 'www.corp.example', 'Corp.Example', 'corp.example:8443', 'localhost', '*.corp.example']) {
      expect(answerMarkChange({ host, status: 'done' }, A).status).toBe(400)
    }
    expect(count()).toBe(0)
  })

  test('refuses (400) a status outside the list, a note that is too long or not text, and a change with neither field', () => {
    expect(answerMarkChange({ host: 'corp.example', status: 'finished' }, A).status).toBe(400)
    expect(answerMarkChange({ host: 'corp.example', note: 'x'.repeat(501) }, A).status).toBe(400)
    expect(answerMarkChange({ host: 'corp.example', note: 7 }, A).status).toBe(400)
    expect(answerMarkChange({ host: 'corp.example' }, A)).toEqual({ status: 400, json: { success: false, error: 'Send a status, a note or both' } })
    expect(count()).toBe(0)
  })

  test('a failure of the database is a 500 for the request, logged', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A name that is not text cannot be bound to the statement: the write fails inside the store.
    expect(answerMarkChange({ host: 'corp.example', status: 'done' }, {} as unknown as string)).toEqual({ status: 500, json: { success: false, error: 'Saving the mark failed' } })
    expect(logged).toHaveBeenCalled()
    expect(dbQuery('SELECT host FROM site_marks')).toEqual([])
  })
})
