import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendStandIn, checkExport, createStandIn, formatLedger, indexLedger, isStandIn, localKey, lookupFile, moveAndLeaveStandIn, parseLedger, parseTelegramExport,
  planTake, replaceWithStandIn, sha256OfFile, writeFileAtomic, type LedgerRow, type TakeInput,
} from '@/lib/ledger-tools'
import { PARSER_REVISION } from '@/lib/parser-version'

const row = (o: Partial<LedgerRow> & { filename: string }): LedgerRow => ({
  kind: 'ledger', size: 1000, sha256: '', lines: 10, revision: PARSER_REVISION, when: '2026-11-06 20:00:00', archived: false, ...o,
})
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-tools-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the plain-text ledger', () => {
  it('round-trips rows, including a name with a tab, a newline and a backslash', () => {
    const rows = [row({ filename: 'plain.txt', sha256: SHA_A, size: 5, archived: true }), row({ kind: 'jobs', filename: 'odd\tname\nwith\\slash.txt', size: 0, revision: 0 })]
    const text = formatLedger(rows)
    expect(text.split('\n').length).toBe(4)   // header, two rows, the empty last line: one row per line whatever the name holds
    expect(parseLedger(text)).toEqual(rows)
  })

  it('ignores the header, blank lines and lines it does not understand', () => {
    expect(parseLedger('#kind\tfilename\n\ngarbage line\nledger\tonly\ttwo\n')).toEqual([])
  })

  it('writes through a temp name: the file appears whole and no temp file is left', () => {
    const out = join(dir, 'sub', 'ledger.tsv')
    writeFileAtomic(out, 'x\n')
    expect(readFileSync(out, 'utf8')).toBe('x\n')
    expect(readdirSync(join(dir, 'sub'))).toEqual(['ledger.tsv'])
  })
})

describe('lookupFile', () => {
  const index = indexLedger([
    row({ filename: 'hashed.txt', sha256: SHA_A, size: 1000 }),
    row({ filename: 'old.txt', size: 0 }),
    row({ filename: 'sized.txt', size: 2000 }),
    row({ kind: 'jobs', filename: 'job-only.txt', size: 0, revision: 0 }),
  ])

  it('finds the same bytes by hash whatever the file is called', () => {
    expect(lookupFile(index, { name: 'hashed (2).txt', size: 1000, sha256: SHA_A })).toMatchObject({ status: 'content', row: { filename: 'hashed.txt' } })
  })

  it('takes a file of a known name with another hash as another file', () => {
    expect(lookupFile(index, { name: 'hashed.txt', size: 1000, sha256: SHA_B }).status).toBe('other-size')
  })

  it('without a hash, a name and a size the ledger holds are the same file', () => {
    expect(lookupFile(index, { name: 'hashed.txt', size: 1000 }).status).toBe('name-size')
    expect(lookupFile(index, { name: 'hashed.txt', size: 999 }).status).toBe('other-size')
  })

  it('a row with no size decides by the name (an import from before sizes were recorded)', () => {
    expect(lookupFile(index, { name: 'old.txt', size: 123456 }).status).toBe('name-size')
  })

  it('a row with a size and no hash is decided by the size', () => {
    expect(lookupFile(index, { name: 'sized.txt', size: 2000, sha256: SHA_B }).status).toBe('name-size')
    expect(lookupFile(index, { name: 'sized.txt', size: 2001, sha256: SHA_B }).status).toBe('other-size')
  })

  it('a name nobody has is new', () => {
    expect(lookupFile(index, { name: 'nothing.txt', size: 1 }).status).toBe('new')
  })
})

describe('a Telegram export', () => {
  const file = (o: Record<string, unknown>) => ({ id: 1, type: 'message', date: '2026-11-05T12:00:00', file_name: 'a.txt', file_size: 5_000_000, ...o })

  it('reads one chat and the whole account', () => {
    const one = { name: 'Chat A', messages: [file({ id: 7 })] }
    const all = { chats: { list: [{ name: 'Chat A', messages: [file({ id: 7 })] }, { name: 'Chat B', messages: [file({ id: 9, file_name: 'b.txt' })] }] } }
    expect(parseTelegramExport(one)).toEqual([{ chat: 'Chat A', messageId: 7, date: '2026-11-05T12:00:00', name: 'a.txt', size: 5_000_000 }])
    expect(parseTelegramExport(all).map(f => [f.chat, f.name])).toEqual([['Chat A', 'a.txt'], ['Chat B', 'b.txt']])
  })

  it('lists a file the export did not include: file_name and file_size are written either way', () => {
    const skipped = file({ file: '(File not included. Change data exporting settings to download.)' })
    expect(parseTelegramExport({ messages: [skipped] })).toHaveLength(1)
  })

  it('ignores messages without a file name or with a size that is not a number', () => {
    const json = { messages: [{ id: 1, type: 'message', text: 'hi' }, file({ file_size: 'nope' }), file({ file_name: '' }), file({ file_size: -1 }), file({ file_size: '12345' })] }
    expect(parseTelegramExport(json).map(f => f.size)).toEqual([12345])
  })

  it('reads nothing from something that is not an export', () => {
    expect(parseTelegramExport(null)).toEqual([])
    expect(parseTelegramExport({ foo: 1 })).toEqual([])
    expect(parseTelegramExport([])).toEqual([])
  })
})

describe('checkExport', () => {
  const index = indexLedger([row({ filename: 'have.txt', size: 3_000_000, sha256: SHA_A }), row({ filename: 'reused.txt', size: 2_000_000 }), row({ kind: 'jobs', filename: 'jobs-only.txt', size: 0, revision: 0 })])
  const f = (name: string, size: number, date = '2026-11-01T00:00:00', chat = 'C') => ({ chat, messageId: 1, date, name, size })
  const opts = { extensions: ['txt'], minSize: 1_000_000 }

  it('sorts the files into NEW, DIFFERENT-SIZE, LOCAL and HAVE', () => {
    const local = new Set([localKey('local.txt', 4_000_000)])
    const v = checkExport([f('have.txt', 3_000_000), f('reused.txt', 9_000_000), f('local.txt', 4_000_000), f('new.txt', 5_000_000), f('jobs-only.txt', 7_000_000)], index, { ...opts, local })
    const by = Object.fromEntries(v.map(x => [x.name, x.status]))
    expect(by).toEqual({ 'new.txt': 'NEW', 'reused.txt': 'DIFFERENT-SIZE', 'local.txt': 'LOCAL', 'have.txt': 'HAVE', 'jobs-only.txt': 'HAVE' })
    expect(v.map(x => x.status)).toEqual(['NEW', 'DIFFERENT-SIZE', 'LOCAL', 'HAVE', 'HAVE'])   // the ones worth a download come first
    expect(v.find(x => x.name === 'jobs-only.txt')!.detail).toBe('in the job log only')
  })

  it('counts the messages that carry one file (a repost) as one line, dated by the first', () => {
    const v = checkExport([f('new.txt', 5_000_000, '2026-11-03T00:00:00', 'B'), f('new.txt', 5_000_000, '2026-11-01T00:00:00', 'A'), f('new.txt', 5_000_001)], index, opts)
    expect(v).toHaveLength(2)
    const same = v.find(x => x.size === 5_000_000)!
    expect(same.copies).toBe(2)
    expect(same.firstMessage.chat).toBe('A')
  })

  it('leaves out the files the filter does not want', () => {
    const v = checkExport([f('pic.png', 5_000_000), f('tiny.txt', 100), f('Big.TXT', 5_000_000)], index, opts)
    expect(v.map(x => x.name)).toEqual(['Big.TXT'])
  })

  it('says a file was imported by an older parser, because a re-feed may be worth it', () => {
    const v = checkExport([f('old.txt', 3_000_000)], indexLedger([row({ filename: 'old.txt', size: 3_000_000, revision: PARSER_REVISION - 2 })]), opts)
    expect(v[0].detail).toContain(`revision ${PARSER_REVISION - 2}`)
  })
})

describe('stand-ins', () => {
  const NS = 1_762_457_312_665_670_631n

  it('creates a file of the size and the modification time asked, with no block on disk', () => {
    const p = join(dir, 'stand.txt')
    expect(createStandIn(p, 4_179_307_720, NS)).toBe(true)
    const st = statSync(p, { bigint: true })
    expect(st.size).toBe(4_179_307_720n)
    expect(st.mtimeNs).toBe(NS)
    expect(st.blocks).toBe(0n)
    expect(isStandIn(p)).toBe(true)
  })

  it('does not touch a file that exists', () => {
    const p = join(dir, 'real.txt')
    writeFileSync(p, 'data')
    expect(createStandIn(p, 99, NS)).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe('data')
    expect(isStandIn(p)).toBe(false)
  })

  it('takes a real file, an empty one and a missing one for no stand-in', () => {
    writeFileSync(join(dir, 'empty.txt'), '')
    expect(isStandIn(join(dir, 'empty.txt'))).toBe(false)
    expect(isStandIn(join(dir, 'missing.txt'))).toBe(false)
  })

  it('moves a download into the inbox and leaves a stand-in with its name, size and time', () => {
    const downloads = join(dir, 'dl'); const inbox = join(dir, 'inbox')
    mkdirSync(downloads); mkdirSync(inbox)
    const src = join(downloads, 'dump.txt')
    writeFileSync(src, 'x'.repeat(5000))
    utimesSync(src, 1_762_457_312, 1_762_457_312.123456)
    const before = statSync(src, { bigint: true })
    const r = moveAndLeaveStandIn(src, join(inbox, 'dump.txt'))
    expect(r.size).toBe(5000)
    expect(readFileSync(join(inbox, 'dump.txt'), 'utf8')).toBe('x'.repeat(5000))
    expect(statSync(join(inbox, 'dump.txt'), { bigint: true }).mtimeNs).toBe(before.mtimeNs)   // a rename keeps the time
    const stand = statSync(src, { bigint: true })
    expect(stand.size).toBe(5000n)
    expect(stand.mtimeNs).toBe(before.mtimeNs)
    expect(stand.blocks).toBe(0n)
  })

  it('refuses to move onto a name that exists, and leaves the download where it is', () => {
    const src = join(dir, 'a.txt'); const dest = join(dir, 'b.txt')
    writeFileSync(src, 'one'); writeFileSync(dest, 'two')
    expect(() => moveAndLeaveStandIn(src, dest)).toThrow(/exists/)
    expect(readFileSync(src, 'utf8')).toBe('one')
    expect(readFileSync(dest, 'utf8')).toBe('two')
  })

  it('swaps a download for a stand-in of the same size and time, and removes the bytes', () => {
    const p = join(dir, 'dl.txt')
    writeFileSync(p, 'y'.repeat(8192))
    const before = statSync(p, { bigint: true })
    replaceWithStandIn(p)
    const after = statSync(p, { bigint: true })
    expect(after.size).toBe(8192n)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect(after.blocks).toBe(0n)
    expect(readdirSync(dir)).toEqual(['dl.txt'])   // the aside copy is gone
  })

  it('writes the registry with a header and one line per stand-in', () => {
    const reg = join(dir, 'standins.tsv')
    appendStandIn(reg, '/d/a.txt', 10, 5n, SHA_A, '2026-11-07T00:00:00Z')
    appendStandIn(reg, '/d/b\tc.txt', 20, 6n, SHA_B, '2026-11-07T00:00:01Z')
    const lines = readFileSync(reg, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0].startsWith('#path')).toBe(true)
    expect(lines[2].split('\t')[0]).toBe('/d/b\\tc.txt')
  })

  it('hashes a file the way sha256sum does', async () => {
    const p = join(dir, 'h.txt')
    writeFileSync(p, 'hello\n')
    expect(await sha256OfFile(p)).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03')
  })
})

describe('planTake', () => {
  const base: TakeInput = { name: 'dump.txt', size: 5000, sha256: SHA_A, archiveHolds: false, inboxNames: new Set(), refeed: false }

  it('moves a file the ledger has never seen', () => {
    expect(planTake(indexLedger([]), base)).toMatchObject({ kind: 'move', destName: 'dump.txt' })
  })

  it('swaps for a stand-in a download whose bytes are ingested and in the source archive', () => {
    const index = indexLedger([row({ filename: 'earlier.txt', sha256: SHA_A, size: 5000, archived: true })])
    expect(planTake(index, { ...base, archiveHolds: true })).toMatchObject({ kind: 'standin-only' })
  })

  it('keeps a download whose bytes are ingested but not in the archive yet (it is the only plaintext)', () => {
    const index = indexLedger([row({ filename: 'earlier.txt', sha256: SHA_A, size: 5000, archived: false })])
    expect(planTake(index, { ...base, archiveHolds: false })).toMatchObject({ kind: 'keep' })
    // the ledger says archived but the manifest does not hold the hash: still keep
    expect(planTake(indexLedger([row({ filename: 'earlier.txt', sha256: SHA_A, size: 5000, archived: true })]), { ...base, archiveHolds: false })).toMatchObject({ kind: 'keep' })
  })

  it('with --refeed moves bytes an older parser imported, under a name that says re-feed', () => {
    const index = indexLedger([row({ filename: 'earlier.txt', sha256: SHA_A, size: 5000, revision: PARSER_REVISION - 1, archived: true })])
    const plan = planTake(index, { ...base, refeed: true, archiveHolds: true })
    expect(plan).toMatchObject({ kind: 'move', destName: `dump (refeed v${(PARSER_REVISION / 10).toFixed(1)}).txt` })
    expect(planTake(index, { ...base, refeed: false, archiveHolds: true }).kind).toBe('standin-only')   // without the flag the download is still a duplicate
  })

  it('--refeed does not move bytes the current parser already imported', () => {
    const index = indexLedger([row({ filename: 'earlier.txt', sha256: SHA_A, size: 5000, archived: true })])
    expect(planTake(index, { ...base, refeed: true, archiveHolds: true }).kind).toBe('standin-only')
  })

  it('refuses a name that is already in the inbox or one of its folders', () => {
    expect(planTake(indexLedger([]), { ...base, inboxNames: new Set(['dump.txt']) })).toMatchObject({ kind: 'refuse' })
  })

  it('moves a name the ledger has with another size: a different file under a used name', () => {
    const index = indexLedger([row({ filename: 'dump.txt', sha256: SHA_B, size: 9999 })])
    expect(planTake(index, base)).toMatchObject({ kind: 'move', note: expect.stringContaining('another size') })
  })

  it('keeps a file whose name and size the ledger holds with no hash to compare', () => {
    expect(planTake(indexLedger([row({ filename: 'dump.txt', size: 5000 })]), base)).toMatchObject({ kind: 'keep' })
  })

  it('moves a name only the job log knows: the importer does not block on it, so it decides', () => {
    expect(planTake(indexLedger([row({ kind: 'jobs', filename: 'dump.txt', size: 0, revision: 0 })]), base)).toMatchObject({ kind: 'move' })
  })
})
