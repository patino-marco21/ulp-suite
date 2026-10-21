/**
 * The clean-up of inbox/done at start-up (lib/inbox-retention.ts).
 *
 * It used to delete every file whose own modification date was older than 7 days. A rename keeps that date, so a file downloaded ten days ago was "old" the
 * moment it was imported, and the next app start deleted it, archived or not. The archive (scripts/archive-sources.ts) is the only other copy of a source file,
 * so the rule is now: a file leaves done/ only when the job log says it was imported more than 7 days ago AND the archive holds that exact file.
 * Real directories, a real archive and the real job log; nothing is mocked.
 */
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeArchiveRef } from '@/lib/archive-ref'
import { DONE_MAX_AGE_MS, archiveLookup, importedAtFromJobLog, pruneDoneFiles, type RetentionLookups } from '@/lib/inbox-retention'
import { appendManifest, archiveFile } from '@/lib/source-archive'
import { dbRun } from '@/lib/sqlite'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-21T21:00:00Z')
const daysAgo = (n: number) => NOW - n * DAY

let root: string
let dir: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'inbox-retention-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => { dir = mkdtempSync(join(root, 'done-')) })

/** A file in done/ whose own modification date is `fileAgeDays` old. */
function put(name: string, fileAgeDays: number, body = 'x'): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  const date = new Date(daysAgo(fileAgeDays))
  utimesSync(path, date, date)
  return path
}

/** importedDaysAgo: name -> how many days ago the job log says it was imported (absent = never). */
function lookups(importedDaysAgo: Record<string, number>, archived: string[] = []): RetentionLookups {
  return {
    importedAt: name => (name in importedDaysAgo ? daysAgo(importedDaysAgo[name]) : null),
    isArchived: path => archived.includes(basename(path)),
  }
}

describe('pruneDoneFiles', () => {
  it('uses a retention of 7 days', () => {
    expect(DONE_MAX_AGE_MS).toBe(7 * DAY)
  })

  it('keeps a file nobody archived, however long ago it was imported', () => {
    const path = put('a.txt', 40)
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, lookups({ 'a.txt': 30 }), NOW)
    expect(existsSync(path)).toBe(true)
    expect(report.deleted).toEqual([])
    expect(report.unarchived).toEqual([{ name: 'a.txt', size: 1 }])
  })

  it('deletes an archived file that was imported more than 7 days ago', () => {
    const path = put('b.txt', 40)
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, lookups({ 'b.txt': 8 }, ['b.txt']), NOW)
    expect(existsSync(path)).toBe(false)
    expect(report.deleted).toEqual(['b.txt'])
  })

  it('keeps an archived file imported yesterday although the file itself is a month old', () => {
    const path = put('c.txt', 30)
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, lookups({ 'c.txt': 1 }, ['c.txt']), NOW)
    expect(existsSync(path)).toBe(true)
    expect(report.young).toBe(1)
    expect(report.deleted).toEqual([])
  })

  it('counts the age from the import, not from the date of the file', () => {
    const path = put('d.txt', 0)
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, lookups({ 'd.txt': 9 }, ['d.txt']), NOW)
    expect(existsSync(path)).toBe(false)
    expect(report.deleted).toEqual(['d.txt'])
  })

  it('keeps a file the job log never imported, archived or not, however old its date', () => {
    const path = put('e.txt', 60)
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, lookups({}, ['e.txt']), NOW)
    expect(existsSync(path)).toBe(true)
    expect(report.unknown).toBe(1)
  })

  it('deletes only what is strictly older than the retention', () => {
    const exact = put('exact.txt', 0)
    const over = put('over.txt', 0)
    const importedAt = (name: string) => (name === 'exact.txt' ? NOW - DONE_MAX_AGE_MS : NOW - DONE_MAX_AGE_MS - 1)
    pruneDoneFiles(dir, DONE_MAX_AGE_MS, { importedAt, isArchived: () => true }, NOW)
    expect(existsSync(exact)).toBe(true)
    expect(existsSync(over)).toBe(false)
  })

  it('goes on with the other files when the lookup fails for one, and keeps that one', () => {
    const bad = put('bad.txt', 40)
    const good = put('good.txt', 40)
    const failing: RetentionLookups = {
      importedAt: () => daysAgo(20),
      isArchived: path => {
        if (basename(path) === 'bad.txt') throw new Error('archive unreadable')
        return true
      },
    }
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, failing, NOW)
    expect(existsSync(bad)).toBe(true)
    expect(existsSync(good)).toBe(false)
    expect(report.deleted).toEqual(['good.txt'])
    expect(report.unarchived.map(f => f.name)).toEqual(['bad.txt'])
  })

  it('leaves a sub-directory alone and does not fail on a missing folder', () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'inner.txt'), 'x')
    const report = pruneDoneFiles(dir, DONE_MAX_AGE_MS, lookups({}, []), NOW)
    expect(existsSync(join(dir, 'sub', 'inner.txt'))).toBe(true)
    expect(report).toEqual({ deleted: [], young: 0, unarchived: [], unknown: 0 })
    expect(() => pruneDoneFiles(join(dir, 'missing'), DONE_MAX_AGE_MS, lookups({}), NOW)).not.toThrow()
  })
})

describe('archiveLookup (a real archive)', () => {
  let arc: string
  let doneDir: string
  const body = 'line one\nline two\nline three\n'

  /** Archives `name` (with `content`) and returns the manifest entry. */
  function archive(name: string, content = body) {
    const src = join(root, `src-${name}`)
    writeFileSync(src, content)
    const entry = archiveFile(src, { archiveDir: arc, name, frameBytes: 64, searchBytes: 32 })
    appendManifest(arc, entry)
    unlinkSync(src)
    return entry
  }
  /** The copy that sits in done/. */
  const inDone = (name: string, content = body) => {
    const path = join(doneDir, name)
    writeFileSync(path, content)
    return path
  }

  beforeEach(() => {
    arc = mkdtempSync(join(root, 'arc-'))
    doneDir = mkdtempSync(join(root, 'dn-'))
  })

  it('matches a file by its name and size', () => {
    archive('f.txt')
    const isArchived = archiveLookup(arc)
    expect(isArchived(inDone('f.txt'), Buffer.byteLength(body))).toBe(true)
  })

  it('does not match the same name with another size', () => {
    archive('f.txt')
    const isArchived = archiveLookup(arc)
    expect(isArchived(inDone('f.txt', body + 'a later, longer download\n'), Buffer.byteLength(body) + 25)).toBe(false)
  })

  it('does not match another name', () => {
    archive('f.txt')
    expect(archiveLookup(arc)(inDone('g.txt'), Buffer.byteLength(body))).toBe(false)
  })

  it('does not match when the archive file is gone or shorter than the manifest says', () => {
    const entry = archive('f.txt')
    const isArchived = archiveLookup(arc)
    const path = inDone('f.txt')
    truncateSync(join(arc, `${entry.id}.zst`), Math.floor(entry.archive_bytes / 2))
    expect(isArchived(path, Buffer.byteLength(body))).toBe(false)
    unlinkSync(join(arc, `${entry.id}.zst`))
    expect(isArchived(path, Buffer.byteLength(body))).toBe(false)
  })

  it('matches nothing, quietly, when the archive has no manifest yet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = inDone('f.txt')
    expect(archiveLookup(arc)(path, Buffer.byteLength(body))).toBe(false)
    expect(archiveLookup(join(root, 'no-such-archive'))(path, Buffer.byteLength(body))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('matches nothing and says why when the manifest is damaged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = inDone('f.txt')
    writeFileSync(join(arc, 'manifest.jsonl'), '{"name":"f.txt"\nnot json at all\n')
    const isArchived = archiveLookup(arc)
    expect(isArchived(path, Buffer.byteLength(body))).toBe(false)
    expect(isArchived(path, Buffer.byteLength(body))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1) // told once, not once per file
    expect(String(warn.mock.calls[0][0])).toMatch(/manifest.*cannot be read.*none is deleted/)
    warn.mockRestore()
  })

  it('counts an .archiveref as archived while the archive file it points to exists', () => {
    const entry = archive('r.txt')
    const ref = join(doneDir, 'r.txt.archiveref')
    writeFileSync(ref, serializeArchiveRef(entry))
    const isArchived = archiveLookup(arc)
    expect(isArchived(ref, 120)).toBe(true)
    unlinkSync(join(arc, `${entry.id}.zst`))
    expect(isArchived(ref, 120)).toBe(false)
  })

  it('does not count an .archiveref that cannot be read', () => {
    archive('r.txt')
    const ref = join(doneDir, 'broken.txt.archiveref')
    writeFileSync(ref, 'not a reference')
    expect(archiveLookup(arc)(ref, 15)).toBe(false)
  })

  it('removes the copy in done/ only through the same rules end to end', () => {
    archive('f.txt')
    const keep = inDone('unarchived.txt')
    const gone = inDone('f.txt')
    const old = new Date(daysAgo(40))
    for (const p of [keep, gone]) utimesSync(p, old, old)
    const report = pruneDoneFiles(doneDir, DONE_MAX_AGE_MS, { importedAt: () => daysAgo(10), isArchived: archiveLookup(arc) }, NOW)
    expect(report.deleted).toEqual(['f.txt'])
    expect(existsSync(keep)).toBe(true)
    expect(existsSync(gone)).toBe(false)
  })
})

describe('importedAtFromJobLog (the real job log)', () => {
  const insert = (source: string, filename: string, status: string, createdAt: string) =>
    dbRun('INSERT INTO processing_jobs (source, filename, status, created_at) VALUES (?, ?, ?, ?)', [source, filename, status, createdAt])

  it('answers the newest finished inbox import of the name, read as UTC', () => {
    insert('inbox', 'retention-x.txt', 'done', '2026-10-14 10:00:00')
    insert('inbox', 'retention-x.txt', 'done', '2026-10-15 12:30:45')
    insert('inbox', 'retention-x.txt', 'failed', '2026-10-20 00:00:00')
    insert('inbox', 'retention-x.txt', 'held', '2026-10-20 01:00:00')
    insert('http', 'retention-x.txt', 'done', '2026-10-20 02:00:00')
    expect(importedAtFromJobLog()('retention-x.txt')).toBe(Date.parse('2026-10-15T12:30:45Z'))
  })

  it('answers null for a name the log never imported', () => {
    insert('inbox', 'retention-y.txt', 'failed', '2026-10-14 10:00:00')
    expect(importedAtFromJobLog()('retention-y.txt')).toBeNull()
    expect(importedAtFromJobLog()('retention-never-seen.txt')).toBeNull()
  })
})

describe('the watcher', () => {
  const watcher = readFileSync(join(__dirname, '..', 'lib', 'inbox-watcher.ts'), 'utf8')

  it('prunes done/ at start-up through the retention rule, with the archive the app mounts', () => {
    const start = watcher.slice(watcher.indexOf('export function startInboxWatcher'))
    expect(start).toMatch(/pruneDone\(\)/)
    expect(watcher).toMatch(/pruneDoneFiles\(DONE, DONE_MAX_AGE_MS, \{ importedAt: importedAtFromJobLog\(\), isArchived: archiveLookup\(appArchiveDir\(\)\) \}\)/)
  })

  it('no longer decides by the modification date of the file', () => {
    expect(watcher).not.toMatch(/mtimeMs/)
    expect(watcher).not.toMatch(/cleanupOldFiles/)
  })

  it('tells docker logs what it deleted and what waits for the archive (console.warn: the production build strips console.log)', () => {
    const body = watcher.slice(watcher.indexOf('function pruneDone'), watcher.indexOf('async function enqueueFile'))
    expect(body).not.toMatch(/console\.log/)
    expect(body).toMatch(/console\.warn\(`\[inbox-watcher\] cleanup: deleted/)
    expect(body).toMatch(/console\.warn\(`\[inbox-watcher\] cleanup: kept/)
  })
})
