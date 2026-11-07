/**
 * The pipeline status (lib/pipeline-status.ts) on made-up facts and on a sandbox folder: every stage has a verdict, the colours come out right, a file name cannot inject into
 * the page, and the stand-in check notices a marker that no longer matches its record. No machine probes run here.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendStandIn, createStandIn, formatLedger, type LedgerRow } from '@/lib/ledger-tools'
import {
  checkStandIns, evaluate, gatherFacts, readMoverRun, renderHtml, renderReadme, renderText, writeMoverRun, writeStatusFiles, type MoverRun, type PipelineFacts, type Probes,
} from '@/lib/pipeline-status'

const NOW = Date.parse('2026-11-07T20:00:00Z')
const run = (o: Partial<MoverRun> = {}): MoverRun => ({ v: 1, at: new Date(NOW - 20_000).toISOString(), ms: 300, applied: true, ok: true, moved: [], swapped: [], kept: [], refused: [], pending: [], failed: [], changed: [], standIns: 30, hashed: 0, ...o })
const facts = (o: Partial<PipelineFacts> = {}): PipelineFacts => ({
  nowMs: NOW,
  paths: { downloads: '/dl', inbox: '/repo/inbox', archive: '/arc', pipeline: '/pipe', ledger: '/pipe/ledger.tsv' },
  downloadsExists: true,
  mover: { timerActive: true, run: run() },
  archive: { timerActive: true, status: { v: 1, at: new Date(NOW - 600_000).toISOString(), ran: false, archived: 0, failed: 0, plain_bytes: 0, verify: null, free_bytes: 150 * 1024 ** 3, ready_files: 0, ready_bytes: 0, unarchived_files: 0, unarchived_bytes: 0, other_files: 0, other_bytes: 0, empty_files: 0 } },
  stack: { app: 'Up 2 hours (healthy)', clickhouse: 'Up 2 days (healthy)' },
  inbox: { waiting: 0, processing: 0, held: [], failed: [] },
  jobs: { done: 20, held: 0, failed: 0, lastDoneAt: '2026-11-07 19:40:00' },
  ledger: { ageMs: 120_000, lines: 940 },
  standIns: { total: 30, broken: [] },
  lastThrough: { name: 'last.txt', movedAt: '2026-11-07T19:30:00.000Z', importedAt: '2026-11-07T19:31:00.000Z', archived: true },
  diskFreeBytes: 155 * 1024 ** 3,
  ...o,
})
const levels = (f: PipelineFacts): Record<string, string> => Object.fromEntries(evaluate(f).checks.map(c => [c.id, c.level]))

describe('evaluate', () => {
  it('everything fine: green, "Fully working"', () => {
    const v = evaluate(facts())
    expect(v.level).toBe('ok')
    expect(v.headline).toBe('Fully working')
    expect(v.checks.map(c => c.level)).toEqual(Array(7).fill('ok'))
  })

  it('the mover: a stopped timer, an old run, an error or a failed file is red; a slightly old run is amber', () => {
    expect(levels(facts({ mover: { timerActive: false, run: run() } })).mover).toBe('fail')
    expect(levels(facts({ mover: { timerActive: true, run: run({ at: new Date(NOW - 15 * 60_000).toISOString() }) } })).mover).toBe('fail')
    expect(levels(facts({ mover: { timerActive: true, run: run({ at: new Date(NOW - 5 * 60_000).toISOString() }) } })).mover).toBe('warn')
    expect(levels(facts({ mover: { timerActive: true, run: run({ ok: false, error: 'boom' }) } })).mover).toBe('fail')
    expect(levels(facts({ mover: { timerActive: true, run: run({ failed: [{ name: 'a.txt', error: 'x' }] }) } })).mover).toBe('fail')
    expect(levels(facts({ mover: { timerActive: true, run: null } })).mover).toBe('warn')
  })

  it('downloads still in progress are normal (green) and explained; an interrupted one or a refused name is amber', () => {
    const busy = facts({ mover: { timerActive: true, run: run({ pending: [{ name: 'big.txt', state: 'downloading', detail: 'still open in another program (pid 1)' }, { name: 'new.txt', state: 'settling', detail: 'last changed 5 s ago' }] }) } })
    const c = evaluate(busy).checks.find(x => x.id === 'downloads')!
    expect(c.level).toBe('ok')
    expect(c.summary).toMatch(/1 file still downloading; 1 file just finished/)
    expect(c.lines.join('\n')).toMatch(/big\.txt: still open/)
    expect(levels(facts({ mover: { timerActive: true, run: run({ pending: [{ name: 'cut.txt', state: 'interrupted', detail: 'holes' }] }) } })).downloads).toBe('warn')
    expect(levels(facts({ mover: { timerActive: true, run: run({ refused: [{ name: 'x.txt', reason: 'name taken' }] }) } })).downloads).toBe('warn')
    expect(levels(facts({ downloadsExists: false })).downloads).toBe('fail')
  })

  it('a stand-in that no longer matches its record is amber and named', () => {
    const v = evaluate(facts({ standIns: { total: 30, broken: [{ name: 'gone.txt', why: 'the file is gone from the folder' }] } }))
    const c = v.checks.find(x => x.id === 'markers')!
    expect(c.level).toBe('warn')
    expect(c.lines).toEqual(['gone.txt: the file is gone from the folder'])
    expect(v.level).toBe('warn')
    expect(v.headline).toMatch(/Working, 1 thing needs you/)
  })

  it('import: an unhealthy stack and a failed file are red; a held file is amber and says where its bytes are', () => {
    expect(levels(facts({ stack: { app: 'Up 1 minute (unhealthy)', clickhouse: 'Up 2 days (healthy)' } })).ingest).toBe('fail')
    expect(levels(facts({ stack: { app: null, clickhouse: 'Up 2 days (healthy)' } })).ingest).toBe('fail')
    expect(levels(facts({ inbox: { waiting: 0, processing: 0, held: [], failed: ['f.txt'] } })).ingest).toBe('fail')
    const held = evaluate(facts({ inbox: { waiting: 0, processing: 0, held: ['h.txt'], failed: [] } })).checks.find(x => x.id === 'ingest')!
    expect(held.level).toBe('warn')
    expect(held.lines.join()).toMatch(/h\.txt/)
    expect(held.todo).toMatch(/inbox\/held/)
  })

  it('archive, ledger copy and disk have their thresholds', () => {
    expect(levels(facts({ archive: { timerActive: false, status: null } })).archive).toBe('fail')
    expect(levels(facts({ ledger: { ageMs: null, lines: 0 } })).ledger).toBe('fail')
    expect(levels(facts({ ledger: { ageMs: 3 * 3600_000, lines: 9 } })).ledger).toBe('warn')
    expect(levels(facts({ diskFreeBytes: 100 * 1024 ** 3 })).disk).toBe('warn')
    expect(levels(facts({ diskFreeBytes: 40 * 1024 ** 3 })).disk).toBe('fail')
    const ready = evaluate(facts({ archive: { timerActive: true, status: { ...facts().archive.status!, ready_files: 33, ready_bytes: 48.5 * 1024 ** 3 } } })).checks.find(x => x.id === 'archive')!
    expect(ready.level).toBe('ok')   // replacing the originals is the owner's decision, not a fault
    expect(ready.lines.join()).toMatch(/33 files/)
  })

  it('red beats amber in the headline', () => {
    const v = evaluate(facts({ mover: { timerActive: false, run: null }, inbox: { waiting: 0, processing: 0, held: ['h.txt'], failed: [] } }))
    expect(v.level).toBe('fail')
    expect(v.headline).toMatch(/^Broken: Mover/)
  })
})

describe('pages', () => {
  it('the text and the page carry the verdict, every stage and the last file through', () => {
    const f = facts(), v = evaluate(f)
    const text = renderText(f, v), html = renderHtml(f, v)
    expect(text).toMatch(/^ULP PIPELINE: FULLY WORKING/)
    for (const c of v.checks) { expect(text).toContain(c.title); expect(html).toContain(c.title.replace(/&/g, '&amp;')) }
    expect(html).toMatch(/class="banner ok"/)
    expect(html).toMatch(/Last file through the whole pipeline: <b>last\.txt<\/b>/)
    expect(renderReadme(f)).toMatch(/\/dl/)
  })

  it('a command to run is shown as code; advice in words is not', () => {
    const cmd = facts({ mover: { timerActive: false, run: null } })
    expect(renderHtml(cmd, evaluate(cmd))).toMatch(/<code>systemctl --user enable --now ulp-pull-downloads\.timer<\/code>/)
    const advice = facts({ inbox: { waiting: 0, processing: 0, held: ['h.txt'], failed: [] } })
    expect(renderHtml(advice, evaluate(advice))).toMatch(/<b>To do:<\/b> Open the Inbox page/)
  })

  it('a file name cannot inject markup into the page', () => {
    const f = facts({ inbox: { waiting: 0, processing: 0, held: ['<script>alert(1)</script>.txt'], failed: [] } })
    const html = renderHtml(f, evaluate(f))
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.txt')
  })
})

describe('on a sandbox folder', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pipeline-status-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')

  it('checkStandIns: an intact stand-in passes; a missing one, a changed one and one that holds real bytes are named', () => {
    const reg = join(root, 'stand-ins.tsv')
    const t = 1_700_000_000_123_456_789n
    const mk = (name: string) => { const p = join(root, name); createStandIn(p, 5_000_000, t); appendStandIn(reg, p, 5_000_000, t, sha(name), '2026-11-07T19:00:00.000Z'); return p }
    mk('ok.txt'); mk('missing.txt'); const changed = mk('changed.txt'); const real = mk('real.txt')
    rmSync(join(root, 'missing.txt'))
    utimesSync(changed, new Date(1_600_000_000_000), new Date(1_600_000_000_000))
    rmSync(real); writeFileSync(real, 'x'.repeat(5_000_000)); utimesSync(real, Number(t / 1_000_000_000n), Number(t / 1_000_000_000n))
    const r = checkStandIns(reg)
    expect(r.total).toBe(4)
    expect(r.broken.map(b => b.name).sort()).toEqual(['changed.txt', 'missing.txt', 'real.txt'])
    expect(checkStandIns(join(root, 'none.tsv'))).toMatchObject({ total: 0, broken: [] })
  })

  it('gatherFacts reads the folders, the ledger copy and the registry; the probes are replaceable', () => {
    const repo = join(root, 'repo'), pipe = join(root, 'pipe'), arc = join(root, 'arc'), dl = join(root, 'dl')
    for (const d of [dl, arc, pipe, ...['', 'processing', 'done', 'held', 'failed'].map(x => join(repo, 'inbox', x))]) mkdirSync(d, { recursive: true })
    writeFileSync(join(repo, 'inbox', 'waiting.txt'), 'x'); writeFileSync(join(repo, 'inbox', 'held', 'h.txt'), 'x'); writeFileSync(join(repo, 'inbox', 'failed', 'f.txt'), 'x')
    const row: LedgerRow = { kind: 'ledger', filename: 'x.txt', size: 5_000_000, sha256: sha('x.txt'), lines: 3, revision: 65, when: '2026-11-07 19:31:00', archived: true }
    const ledger = join(pipe, 'ledger.tsv')
    writeFileSync(ledger, formatLedger([row]))
    const t = 1_700_000_000_000_000_000n
    const p = join(dl, 'x.txt'); createStandIn(p, 5_000_000, t); appendStandIn(join(pipe, 'stand-ins.tsv'), p, 5_000_000, t, sha('x.txt'), '2026-11-07T19:30:00.000Z')
    writeMoverRun(pipe, run())
    expect(readMoverRun(pipe)).toMatchObject({ v: 1, ok: true })
    const probes: Probes = { timerActive: u => u.startsWith('ulp-pull'), containerStatus: n => `Up 1 hour (healthy) ${n}`, jobs: () => ({ done: 2, held: 1, failed: 0, lastDoneAt: null }) }
    const f = gatherFacts({ downloads: dl, repo, archive: arc, pipeline: pipe, ledger, nowMs: Date.now() }, probes)
    expect(f.inbox).toEqual({ waiting: 1, processing: 0, held: ['h.txt'], failed: ['f.txt'] })
    expect(f.mover.timerActive).toBe(true)
    expect(f.archive.timerActive).toBe(false)
    expect(f.ledger.lines).toBe(1)
    expect(f.standIns).toEqual({ total: 1, broken: [] })
    expect(f.lastThrough).toEqual({ name: 'x.txt', movedAt: '2026-11-07T19:30:00.000Z', importedAt: '2026-11-07T19:31:00Z', archived: true })
    const v = writeStatusFiles(f)
    expect(v.level).toBe('fail')   // the archive timer probe says inactive, and a file failed
    expect(readFileSync(join(pipe, 'STATUS.txt'), 'utf8')).toMatch(/Archive \(compressed copy/)
  })

  it('readMoverRun ignores a missing or foreign file', () => {
    expect(readMoverRun(root)).toBeNull()
    writeFileSync(join(root, 'last-run.json'), '{"v":2}')
    expect(readMoverRun(root)).toBeNull()
  })
})
