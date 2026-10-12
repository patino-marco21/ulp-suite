/** The guards of `archive-sources archive --replace`: plain values in, reasons out; and the unlink helper against real temp directories. */
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  FREE_MARGIN_BYTES, MIN_AGE_MS, inboxIsBusy, replaceOriginal, replaceRefusals, sameInodeNames, spaceRefusal, type ReplaceFacts,
} from '@/lib/archive-replace'

const GiB = 1024 ** 3

describe('replaceRefusals', () => {
  const quiet: ReplaceFacts = { nowMs: 100 * MIN_AGE_MS, mtimeMs: 0, inboxBusy: false, inSources: true, includeUnimported: false }

  test('a quiet inbox and an old file that is in ulp.sources: nothing to refuse', () => {
    expect(replaceRefusals(quiet)).toEqual([])
  })
  test('a busy inbox refuses', () => {
    expect(replaceRefusals({ ...quiet, inboxBusy: true })[0]).toMatch(/in flight/)
  })
  test('a file modified 9 minutes ago is refused, one modified 11 minutes ago is not', () => {
    const now = 1_000_000_000
    expect(replaceRefusals({ ...quiet, nowMs: now, mtimeMs: now - 9 * 60_000 })[0]).toMatch(/last 10 minutes/)
    expect(replaceRefusals({ ...quiet, nowMs: now, mtimeMs: now - 11 * 60_000 })).toEqual([])
  })
  test('a name that is not in ulp.sources is refused unless --include-unimported', () => {
    expect(replaceRefusals({ ...quiet, inSources: false })[0]).toMatch(/not in ulp\.sources/)
    expect(replaceRefusals({ ...quiet, inSources: false, includeUnimported: true })).toEqual([])
  })
  test('every reason is reported', () => {
    expect(replaceRefusals({ ...quiet, inboxBusy: true, mtimeMs: quiet.nowMs, inSources: false })).toHaveLength(3)
  })
})

describe('spaceRefusal', () => {
  test('needs 10 GiB plus twice the file', () => {
    expect(spaceRefusal(FREE_MARGIN_BYTES + 2 * GiB, GiB)).toBeNull()
    expect(spaceRefusal(FREE_MARGIN_BYTES + 2 * GiB - 1, GiB)).toMatch(/free space/)
    expect(spaceRefusal(5 * GiB, 0)).toMatch(/free space/)
  })
  test('the margin can be lowered (CI runners, tests)', () => {
    expect(spaceRefusal(3 * GiB, GiB, 0)).toBeNull()
    expect(spaceRefusal(3 * GiB, GiB, 2 * GiB)).toMatch(/free space/)    // a 2 GiB margin plus twice the file is 4 GiB
  })
})

describe('inboxIsBusy and replaceOriginal', () => {
  let root: string
  let pile: string
  let inbox: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'archive-replace-')) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  beforeEach(() => {
    const t = mkdtempSync(join(root, 't-'))
    pile = join(t, 'pile'); inbox = join(t, 'inbox')
    for (const d of [pile, join(inbox, 'done'), join(inbox, 'failed'), join(inbox, 'processing')]) mkdirSync(d, { recursive: true })
  })

  test('an inbox with only sub-directories and an empty processing/ is quiet', () => {
    expect(inboxIsBusy(inbox)).toBe(false)
    expect(inboxIsBusy(join(inbox, 'does-not-exist'))).toBe(false)
  })
  test('a top-level file or something in processing/ makes it busy; done/ and failed/ do not', () => {
    writeFileSync(join(inbox, 'done', 'x.txt'), 'x'); writeFileSync(join(inbox, 'failed', 'y.txt'), 'y')
    expect(inboxIsBusy(inbox)).toBe(false)
    writeFileSync(join(inbox, 'processing', 'p.txt'), 'p')
    expect(inboxIsBusy(inbox)).toBe(true)
    rmSync(join(inbox, 'processing', 'p.txt'))
    writeFileSync(join(inbox, 'pending.txt'), 'q')
    expect(inboxIsBusy(inbox)).toBe(true)
  })

  test('removes the original and only the names that share its inode', () => {
    const orig = join(pile, 'o.txt')
    writeFileSync(orig, 'same bytes\n')
    linkSync(orig, join(inbox, 'done', 'o.txt'))                                // a hardlink of the original: goes
    writeFileSync(join(inbox, 'done', 'copy.txt'), 'same bytes\n')              // the same content, another inode: stays
    symlinkSync(orig, join(inbox, 'done', 'link.txt'))                          // a symlink: stays
    linkSync(orig, join(inbox, 'failed', 'o.txt'))                              // a hardlink in a directory we were not given: stays
    const st = statSync(orig)
    expect(sameInodeNames(orig, [join(inbox, 'done')])).toEqual([join(inbox, 'done', 'o.txt')])

    const removed = replaceOriginal(orig, [join(inbox, 'done')], { size: st.size, mtimeMs: st.mtimeMs })
    expect(removed.sort()).toEqual([join(inbox, 'done', 'o.txt'), orig].sort())
    expect(existsSync(orig)).toBe(false)
    expect(existsSync(join(inbox, 'done', 'o.txt'))).toBe(false)
    expect(readFileSync(join(inbox, 'done', 'copy.txt'), 'utf8')).toBe('same bytes\n')
    expect(lstatSync(join(inbox, 'done', 'link.txt')).isSymbolicLink()).toBe(true)   // dangling now, but it was never unlinked
    expect(readFileSync(join(inbox, 'failed', 'o.txt'), 'utf8')).toBe('same bytes\n')
  })

  test('removes nothing when the original changed since it was archived (size or modification time)', () => {
    const orig = join(pile, 'c.txt')
    writeFileSync(orig, 'abcdef')
    linkSync(orig, join(inbox, 'done', 'c.txt'))
    const { mtimeMs } = statSync(orig)
    expect(() => replaceOriginal(orig, [join(inbox, 'done')], { size: 5, mtimeMs })).toThrow(/changed while it was archived/)
    expect(() => replaceOriginal(orig, [join(inbox, 'done')], { size: 6, mtimeMs: mtimeMs - 1000 })).toThrow(/changed while it was archived/)
    expect(existsSync(orig)).toBe(true)
    expect(existsSync(join(inbox, 'done', 'c.txt'))).toBe(true)
  })
})
