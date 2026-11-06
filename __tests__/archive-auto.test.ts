import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_IDLE_MS, FAILURE_BACKOFF_MS, archiveNote, failureBackoff, idleRefusals, inboxLastActivityMs, parseArchiveSummary, parseVerifySummary, readStatus, readyToReplace, writeStatus, type AutoArchiveStatus,
} from '@/lib/archive-auto'
import type { ManifestEntry } from '@/lib/source-archive'

const GiB = 1024 ** 3
const MIN = 60_000

describe('idleRefusals', () => {
  const quiet = { nowMs: 100 * MIN, inboxBusy: false, lastActivityMs: 0, idleMs: DEFAULT_IDLE_MS }
  test('a quiet inbox that has been still for the whole wait: nothing to refuse', () => {
    expect(idleRefusals(quiet)).toEqual([])
  })
  test('a file waiting or in flight refuses, whatever the quiet time', () => {
    expect(idleRefusals({ ...quiet, inboxBusy: true })[0]).toMatch(/waiting or in flight/)
  })
  test('an inbox that changed 19 minutes ago refuses, one that changed 21 minutes ago does not (default wait 20 minutes)', () => {
    expect(DEFAULT_IDLE_MS).toBe(20 * MIN)
    expect(idleRefusals({ ...quiet, nowMs: 100 * MIN, lastActivityMs: 81 * MIN })[0]).toMatch(/19 minutes ago/)
    expect(idleRefusals({ ...quiet, nowMs: 100 * MIN, lastActivityMs: 79 * MIN })).toEqual([])
  })
  test('an inbox with no folders at all (nothing ever happened) is quiet', () => {
    expect(idleRefusals({ ...quiet, lastActivityMs: null })).toEqual([])
  })
})

describe('failureBackoff', () => {
  const failedRun = { at: new Date(10 * 60 * MIN).toISOString(), failed: 2, verify: null }
  test('a run that failed is not repeated for 6 hours, so a file that cannot be archived is not compressed again every 30 minutes', () => {
    expect(FAILURE_BACKOFF_MS).toBe(6 * 60 * MIN)
    expect(failureBackoff(failedRun, 10 * 60 * MIN + 5 * 60 * MIN)).toMatch(/failed .* ago.*waits 6 hours/)
    expect(failureBackoff(failedRun, 10 * 60 * MIN + 6 * 60 * MIN)).toBeNull()
  })
  test('a failed sample check counts the same, a clean run and no earlier run never wait', () => {
    expect(failureBackoff({ ...failedRun, failed: 0, verify: { checked: 3, failed: 1 } }, 10 * 60 * MIN + MIN)).not.toBeNull()
    expect(failureBackoff({ ...failedRun, failed: 0, verify: { checked: 3, failed: 0 } }, 10 * 60 * MIN + MIN)).toBeNull()
    expect(failureBackoff(null, 0)).toBeNull()
  })
})

describe('on disk', () => {
  let root: string
  let inbox: string
  let archive: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-auto-')) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  beforeEach(() => {
    const t = mkdtempSync(join(root, 't-'))
    inbox = join(t, 'inbox'); archive = join(t, 'archive')
    for (const d of [join(inbox, 'done'), join(inbox, 'failed'), join(inbox, 'processing'), join(inbox, 'held'), archive]) mkdirSync(d, { recursive: true })
  })
  const entry = (name: string, size: number, id = `id-${name}`): ManifestEntry => ({
    name, id, size, sha256: 'x', lines: 1, frames: [], archive_bytes: 1, archive_sha256: 'y', level: 12, created_at: '2026-11-05T00:00:00Z',
  })

  test('inboxLastActivityMs is the newest change of any inbox folder, and null when there is no inbox', () => {
    expect(inboxLastActivityMs(join(inbox, 'nope'))).toBeNull()
    const old = new Date('2026-01-01T00:00:00Z')
    for (const d of [inbox, join(inbox, 'done'), join(inbox, 'failed'), join(inbox, 'processing'), join(inbox, 'held')]) utimesSync(d, old, old)
    const recent = new Date('2026-02-01T00:00:00Z')
    utimesSync(join(inbox, 'failed'), recent, recent)
    expect(inboxLastActivityMs(inbox)).toBe(recent.getTime())
  })

  test('readyToReplace counts the archived files in done/ once per inode, and separates what cannot be replaced', () => {
    const done = join(inbox, 'done')
    writeFileSync(join(done, 'archived.txt'), 'a'.repeat(100))
    linkSync(join(done, 'archived.txt'), join(done, 'archived second name.txt'))   // one inode, two names: freed once
    writeFileSync(join(done, 'changed.txt'), 'b'.repeat(50))                       // archived at another size: not ready
    writeFileSync(join(done, 'new.txt'), 'c'.repeat(30))                           // never archived
    writeFileSync(join(done, 'note.csv'), 'd'.repeat(20))                          // the tool reads *.txt names only
    writeFileSync(join(done, 'empty.txt'), '')                                     // a failed copy
    writeFileSync(join(archive, 'id-archived.txt.zst'), 'z'); writeFileSync(join(archive, 'id-archived second name.txt.zst'), 'z'); writeFileSync(join(archive, 'id-changed.txt.zst'), 'z')
    const latest = new Map<string, ManifestEntry>([
      ['archived.txt', entry('archived.txt', 100)],
      ['archived second name.txt', entry('archived second name.txt', 100)],
      ['changed.txt', entry('changed.txt', 49)],
    ])
    const r = readyToReplace(done, archive, latest)
    expect(r).toEqual({ ready_files: 2, ready_bytes: 100, unarchived_files: 2, unarchived_bytes: 80, other_files: 1, other_bytes: 20, empty_files: 1 })
  })

  test('a manifest entry whose archive file is gone is not ready', () => {
    const done = join(inbox, 'done')
    writeFileSync(join(done, 'lost.txt'), 'e'.repeat(10))
    const r = readyToReplace(done, archive, new Map([['lost.txt', entry('lost.txt', 10)]]))
    expect(r.ready_files).toBe(0)
    expect(r.unarchived_files).toBe(1)
  })

  test('the status file is written whole and read back; a missing or damaged file reads as null', () => {
    const s: AutoArchiveStatus = {
      v: 1, at: '2026-11-05T22:00:00.000Z', ran: true, archived: 3, failed: 0, plain_bytes: 5 * GiB, verify: { checked: 3, failed: 0 },
      ready_files: 3, ready_bytes: 5 * GiB, unarchived_files: 0, unarchived_bytes: 0, other_files: 0, other_bytes: 0, empty_files: 0, free_bytes: 200 * GiB,
    }
    expect(readStatus(archive)).toBeNull()
    writeStatus(archive, s)
    expect(readStatus(archive)).toEqual(s)
    expect(existsSync(join(archive, 'auto-archive-status.json.part'))).toBe(false)
    writeFileSync(join(archive, 'auto-archive-status.json'), '{ not json')
    expect(readStatus(archive)).toBeNull()
    writeFileSync(join(archive, 'auto-archive-status.json'), JSON.stringify({ v: 2 }))
    expect(readStatus(archive)).toBeNull()
  })
})

describe('the tool\'s summary lines', () => {
  test('parseArchiveSummary reads the counts and the plaintext size', () => {
    expect(parseArchiveSummary('kept x: y\narchived 11, already archived 8, too young 1, replaced 0, kept 0, failed 2; plaintext 19.20 GiB\nulp.sources was not updated')).toEqual({ archived: 11, already: 8, young: 1, failed: 2, plain_bytes: Math.round(19.2 * GiB) })
    expect(parseArchiveSummary('nothing here')).toBeNull()
  })
  test('parseVerifySummary reads checked and failed', () => {
    expect(parseVerifySummary('ok   1/3 abc\nverified 3, failed 1\n')).toEqual({ checked: 3, failed: 1 })
    expect(parseVerifySummary('')).toBeNull()
  })
})

describe('archiveNote', () => {
  const base: AutoArchiveStatus = {
    v: 1, at: '2026-11-05T22:00:00.000Z', ran: true, archived: 11, failed: 0, plain_bytes: 19.2 * GiB, verify: { checked: 3, failed: 0 },
    ready_files: 19, ready_bytes: 42.8 * GiB, unarchived_files: 0, unarchived_bytes: 0, other_files: 0, other_bytes: 0, empty_files: 0, free_bytes: 163 * GiB,
  }
  test('names what was archived, the check, what is ready to replace, what the replace would free and the free disk', () => {
    expect(archiveNote(base)).toBe('Archive: 11 files archived (19.2 GiB), 3 of 3 sampled files verified. 19 files are ready to replace: removing their plaintext would free about 42.8 GiB. Free disk: 163.0 GiB. Nothing is removed without you.')
  })
  test('says so when nothing was new, and when a check or an archive failed', () => {
    expect(archiveNote({ ...base, ran: false, archived: 0, verify: null, ready_files: 0, ready_bytes: 0 })).toBe('Archive: nothing new to archive. Nothing is ready to replace. Free disk: 163.0 GiB. Nothing is removed without you.')
    expect(archiveNote({ ...base, failed: 2, verify: { checked: 3, failed: 1 } })).toMatch(/2 files FAILED to archive.*1 of 3 sampled files FAILED the check/)
  })
  test('a run that could not archive or check anything says so, without a negative count', () => {
    const note = archiveNote({ ...base, archived: 0, plain_bytes: 0, failed: 1, verify: { checked: 0, failed: 1 }, ready_files: 0, ready_bytes: 0 })
    expect(note).toMatch(/^Archive: no file was archived\. 1 file FAILED to archive\. The sample check FAILED to run\. Nothing is ready to replace\./)
    expect(note).not.toMatch(/-\d|sampled/)
  })
  test('mentions the files the tool cannot archive and the files still waiting for their turn', () => {
    const note = archiveNote({ ...base, unarchived_files: 2, unarchived_bytes: 3 * GiB, other_files: 1, other_bytes: 1 * GiB, empty_files: 5 })
    expect(note).toMatch(/2 files \(3\.0 GiB\) in done\/ are not archived yet/)
    expect(note).toMatch(/1 file \(1\.0 GiB\) with another name than \*\.txt is not archived by the tool/)
    expect(note).toMatch(/5 files of 0 bytes/)
  })
})
