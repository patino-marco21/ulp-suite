/**
 * The pipeline status (docs/superpowers/specs/2026-11-07-download-mover-design.md): one page that says whether the whole path a download takes is working, written by the
 * mover's minute timer next to the ledger copy (STATUS.html to open in a browser, STATUS.txt for a terminal; `tsx scripts/pipeline-status.ts` prints it).
 *
 *   download in AyuGram -> mover (waits until the client has closed the file) -> inbox -> import -> archive,  and a stand-in stays where the download was
 *
 * `gatherFacts` reads the machine (timers, containers, folders, the job log); `evaluate` turns the facts into a verdict per stage and an overall colour; `renderText`,
 * `renderHtml` and `renderReadme` print it. Only `gatherFacts` touches the machine, so the rest is tested on made-up facts. This file holds no file names of its own; the pages
 * it writes do, and live outside the repository.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'
import { readStatus, type AutoArchiveStatus } from '@/lib/archive-auto'
import { readLedgerFile } from '@/lib/ledger-tools'
import { standInRegistryFile } from '@/lib/ledger-export'
import type { PendingFile } from '@/lib/stand-in-sweep'

export const MOVER_STATE_FILE = 'last-run.json'
export const MOVER_TIMER = 'ulp-pull-downloads.timer'
export const ARCHIVE_TIMER = 'ulp-archive-auto.timer'

const GiB = 1024 ** 3
/** The disk gates the pipeline already has (CLAUDE.md, README): heavy jobs refuse below the first, the ingest pauses below the second. */
export const DISK_WARN_GIB = 140.52
export const DISK_FAIL_GIB = 50

// ── what the mover leaves behind ────────────────────────────────────────────────────────────────────────

export interface MoverRun {
  v: 1
  /** When the run finished (ISO). */
  at: string
  ms: number
  applied: boolean
  ok: boolean
  error?: string
  moved: string[]
  swapped: string[]
  /** Real files that stay: ingested but not archived yet, or known by name and size without a hash. */
  kept: string[]
  refused: Array<{ name: string; reason: string }>
  pending: PendingFile[]
  failed: Array<{ name: string; error: string }>
  changed: string[]
  standIns: number
  hashed: number
}

export function writeMoverRun(dir: string, run: MoverRun): void {
  const path = join(dir, MOVER_STATE_FILE)
  writeFileSync(`${path}.part`, JSON.stringify(run) + '\n')
  renameSync(`${path}.part`, path)
}

/** The last run the mover recorded, or null when there is none or it is not one this version understands. Never throws. */
export function readMoverRun(dir: string): MoverRun | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, MOVER_STATE_FILE), 'utf8')) as Partial<MoverRun>
    return r && r.v === 1 && typeof r.at === 'string' ? (r as MoverRun) : null
  } catch {
    return null
  }
}

// ── facts ───────────────────────────────────────────────────────────────────────────────────────────────

export interface PipelineFacts {
  nowMs: number
  paths: { downloads: string; inbox: string; archive: string; pipeline: string; ledger: string }
  downloadsExists: boolean
  mover: { timerActive: boolean | null; run: MoverRun | null }
  archive: { timerActive: boolean | null; status: AutoArchiveStatus | null }
  stack: { app: string | null; clickhouse: string | null }
  inbox: { waiting: number; processing: number; held: string[]; failed: string[] }
  jobs: { done: number; held: number; failed: number; lastDoneAt: string | null } | null
  ledger: { ageMs: number | null; lines: number }
  standIns: { total: number; broken: Array<{ name: string; why: string }> }
  lastThrough: { name: string; movedAt: string; importedAt: string | null; archived: boolean } | null
  diskFreeBytes: number | null
}

/** The machine-facing probes, replaceable in tests. Each returns null when it cannot tell. */
export interface Probes {
  timerActive: (unit: string) => boolean | null
  containerStatus: (name: string) => string | null
  jobs: (dbPath: string) => PipelineFacts['jobs']
}

export const systemProbes: Probes = {
  timerActive(unit) {
    const r = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', timeout: 5000 })
    if (r.error) return null
    return r.stdout.trim() === 'active'
  },
  containerStatus(name) {
    const r = spawnSync('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Status}}'], { encoding: 'utf8', timeout: 10_000 })
    if (r.error || r.status !== 0) return null
    return r.stdout.trim() === '' ? 'missing' : r.stdout.trim()
  },
  jobs(dbPath) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      try {
        const rows = db.prepare("select status, count(*) as n, max(created_at) as last from processing_jobs where created_at >= datetime('now','-24 hours') group by status").all() as Array<{ status: string; n: number; last: string }>
        const n = (s: string): number => rows.find(r => r.status === s)?.n ?? 0
        return { done: n('done'), held: n('held'), failed: n('failed'), lastDoneAt: rows.find(r => r.status === 'done')?.last ?? null }
      } finally { db.close() }
    } catch { return null }
  },
}

const listNames = (dir: string): string[] => { try { return readdirSync(dir).filter(n => !n.startsWith('.')).sort() } catch { return [] } }
const utcToIso = (s: string): string => (/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')

/** The stand-ins of the registry (the last line of a path wins) checked against the disk: size, modification time to the nanosecond, and no blocks. */
export function checkStandIns(registry: string): { total: number; broken: Array<{ name: string; why: string }>; entries: Array<{ path: string; sha256: string; created: string }> } {
  const last = new Map<string, { size: number; mtimeNs: bigint; sha256: string; created: string }>()
  if (existsSync(registry)) {
    for (const line of readFileSync(registry, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#')) continue
      const [p, size, mtimeNs, sha256, created] = line.split('\t')
      last.set(p, { size: Number(size), mtimeNs: BigInt(mtimeNs), sha256, created })
    }
  }
  const broken: Array<{ name: string; why: string }> = []
  for (const [p, want] of last) {
    try {
      const st = statSync(p, { bigint: true })
      if (st.size !== BigInt(want.size) || st.mtimeNs !== want.mtimeNs) broken.push({ name: basename(p), why: 'its size or modification time is not the recorded one' })
      else if (st.blocks !== 0n) broken.push({ name: basename(p), why: 'it holds real bytes (it is not a stand-in any more)' })
    } catch {
      broken.push({ name: basename(p), why: 'the file is gone from the folder' })
    }
  }
  return { total: last.size, broken, entries: [...last].map(([path, v]) => ({ path, sha256: v.sha256, created: v.created })) }
}

export function gatherFacts(ctx: { downloads: string; repo: string; archive: string; pipeline: string; ledger: string; nowMs?: number }, probes: Probes = systemProbes): PipelineFacts {
  const nowMs = ctx.nowMs ?? Date.now()
  const inbox = join(ctx.repo, 'inbox')
  const registry = standInRegistryFile(ctx.ledger)
  const markers = checkStandIns(registry)

  let ledgerRows: ReturnType<typeof readLedgerFile> = []
  let ledgerAge: number | null = null
  try { ledgerAge = nowMs - statSync(ctx.ledger).mtimeMs; ledgerRows = readLedgerFile(ctx.ledger) } catch { /* no copy yet */ }
  const bySha = new Map(ledgerRows.filter(r => r.kind === 'ledger' && r.sha256 !== '').map(r => [r.sha256, r]))

  // the newest stand-in whose bytes the ledger knows: a file that went the whole way
  let lastThrough: PipelineFacts['lastThrough'] = null
  for (const e of [...markers.entries].sort((a, b) => b.created.localeCompare(a.created))) {
    const row = bySha.get(e.sha256)
    if (row) { lastThrough = { name: basename(e.path), movedAt: e.created, importedAt: utcToIso(row.when), archived: row.archived }; break }
  }

  let free: number | null = null
  try { const fs = statfsSync(ctx.repo); free = Number(fs.bavail) * Number(fs.bsize) } catch { /* unknown */ }

  return {
    nowMs,
    paths: { downloads: ctx.downloads, inbox, archive: ctx.archive, pipeline: ctx.pipeline, ledger: ctx.ledger },
    downloadsExists: existsSync(ctx.downloads),
    mover: { timerActive: probes.timerActive(MOVER_TIMER), run: readMoverRun(ctx.pipeline) },
    archive: { timerActive: probes.timerActive(ARCHIVE_TIMER), status: readStatus(ctx.archive) },
    stack: { app: probes.containerStatus('ulpsuite_app'), clickhouse: probes.containerStatus('ulpsuite_clickhouse') },
    inbox: {
      waiting: listNames(inbox).filter(n => { try { return statSync(join(inbox, n)).isFile() } catch { return false } }).length,
      processing: listNames(join(inbox, 'processing')).length,
      held: listNames(join(inbox, 'held')),
      failed: listNames(join(inbox, 'failed')),
    },
    jobs: probes.jobs(join(ctx.repo, 'data', 'ulp.db')),
    ledger: { ageMs: ledgerAge, lines: ledgerRows.filter(r => r.kind === 'ledger').length },
    standIns: { total: markers.total, broken: markers.broken },
    lastThrough,
    diskFreeBytes: free,
  }
}

// ── verdicts ────────────────────────────────────────────────────────────────────────────────────────────

export type Level = 'ok' | 'warn' | 'fail'
export interface Check { id: string; title: string; level: Level; summary: string; lines: string[]; todo?: string }
export interface Verdict { level: Level; headline: string; checks: Check[] }

const gib = (n: number): string => (n / GiB).toFixed(1)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s ago`
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`
  if (s < 36 * 3600) return `${(s / 3600).toFixed(1)} h ago`
  return `${Math.round(s / 86400)} days ago`
}
const first = (xs: string[], n = 6): string[] => (xs.length > n ? [...xs.slice(0, n), `… and ${xs.length - n} more`] : xs)
const healthy = (s: string | null): boolean => s !== null && /^Up /.test(s) && !/unhealthy|starting/.test(s)

export function evaluate(f: PipelineFacts): Verdict {
  const checks: Check[] = []
  const run = f.mover.run

  // 1. the mover
  {
    const c: Check = { id: 'mover', title: 'Mover: finished downloads go to the inbox', level: 'ok', summary: '', lines: [] }
    if (f.mover.timerActive === false) { c.level = 'fail'; c.summary = 'The mover timer is not running, so nothing moves by itself.'; c.todo = `systemctl --user enable --now ${MOVER_TIMER}` }
    else if (!run) { c.level = 'warn'; c.summary = 'The mover has not run yet.'; c.todo = `systemctl --user start ${MOVER_TIMER.replace('.timer', '.service')}` }
    else {
      const age = f.nowMs - Date.parse(run.at)
      if (!run.ok) { c.level = 'fail'; c.summary = `The last run stopped with an error: ${run.error ?? 'unknown'}`; c.todo = 'journalctl --user -u ulp-pull-downloads.service -n 30' }
      else if (run.failed.length > 0) { c.level = 'fail'; c.summary = `${plural(run.failed.length, 'file')} could not be moved or swapped.`; c.lines = first(run.failed.map(x => `${x.name}: ${x.error}`)); c.todo = 'journalctl --user -u ulp-pull-downloads.service -n 30' }
      else if (age > 10 * 60_000) { c.level = 'fail'; c.summary = `Last ran ${ago(age)}; it should run every minute.`; c.todo = `systemctl --user restart ${MOVER_TIMER}` }
      else if (age > 3 * 60_000) { c.level = 'warn'; c.summary = `Last ran ${ago(age)}; it should run every minute.` }
      else c.summary = `Runs every minute; last run ${ago(age)}${run.applied ? '' : ' (a dry run: nothing is moved)'}.`
      if (run.moved.length > 0) c.lines.push(`Moved on the last run: ${first(run.moved).join('; ')}`)
    }
    checks.push(c)
  }

  // 2. the download folder
  {
    const c: Check = { id: 'downloads', title: 'Downloads folder', level: 'ok', summary: '', lines: [] }
    const run0 = run
    if (!f.downloadsExists) { c.level = 'fail'; c.summary = `The download folder does not exist: ${f.paths.downloads}`; c.todo = 'Check the folder AyuGram saves to (ULP_DOWNLOAD_DIR).' }
    else if (!run0) c.summary = 'No pass has looked at the folder yet.'
    else {
      const by = (s: string) => run0.pending.filter(p => p.state === s)
      const downloading = by('downloading'), settling = by('settling'), interrupted = by('interrupted')
      const parts: string[] = []
      if (downloading.length) parts.push(`${plural(downloading.length, 'file')} still downloading`)
      if (settling.length) parts.push(`${plural(settling.length, 'file')} just finished, waiting out the quiet period`)
      c.summary = parts.length ? parts.join('; ') + '. They move by themselves when the client has closed them.' : 'Nothing is waiting: every finished download has been moved.'
      for (const p of run0.pending) c.lines.push(`${p.name}: ${p.detail}`)
      if (interrupted.length) { c.level = 'warn'; c.summary = `${plural(interrupted.length, 'download')} look interrupted. ` + c.summary; c.todo = 'Delete the partial file and download it again.' }
      if (run0.refused.length) { c.level = 'warn'; c.lines.push(...run0.refused.map(r => `${r.name}: ${r.reason}`)); c.todo = 'Rename or remove the file with the same name in the inbox, or rename the download.' }
      if (run0.kept.length) c.lines.push(`Stays as a real file (${run0.kept.length}): ingested before but not in the archive yet, or known by name and size without a hash.`)
    }
    c.lines = first(c.lines, 10)
    checks.push(c)
  }

  // 3. the downloaded markers
  {
    const c: Check = { id: 'markers', title: 'AyuGram shows them as downloaded (stand-ins)', level: 'ok', summary: '', lines: [] }
    if (f.standIns.broken.length > 0) {
      c.level = 'warn'
      c.summary = `${plural(f.standIns.total - f.standIns.broken.length, 'stand-in')} intact, ${f.standIns.broken.length} differ from their record, so AyuGram may offer those downloads again.`
      c.lines = first(f.standIns.broken.map(b => `${b.name}: ${b.why}`))
      c.todo = 'A file you deleted or re-downloaded needs nothing; a stand-in that lost its record can be re-made from the archive with: npx tsx scripts/stand-in-sweep.ts --restore <path> (then it is swapped again).'
    } else c.summary = `${plural(f.standIns.total, 'stand-in')}, all with the recorded size and modification time and no disk used. Restarts and reboots do not change that.`
    checks.push(c)
  }

  // 4. import
  {
    const c: Check = { id: 'ingest', title: 'Import (inbox → database)', level: 'ok', summary: '', lines: [] }
    if (!healthy(f.stack.app) || !healthy(f.stack.clickhouse)) {
      c.level = 'fail'
      c.summary = `The stack is not healthy (app: ${f.stack.app ?? 'unknown'}; database: ${f.stack.clickhouse ?? 'unknown'}). Files wait in the inbox.`
      c.todo = 'docker compose up -d   (from the primary checkout only)'
    } else {
      const busy = f.inbox.waiting + f.inbox.processing
      c.summary = busy > 0 ? `Importing: ${f.inbox.waiting} waiting, ${f.inbox.processing} in progress.` : 'Idle: nothing waiting.'
      if (f.jobs) c.summary += ` Last 24 h: ${f.jobs.done} done, ${f.jobs.held} held, ${f.jobs.failed} failed${f.jobs.lastDoneAt ? `; last finished ${ago(f.nowMs - Date.parse(utcToIso(f.jobs.lastDoneAt)))}` : ''}.`
      if (f.inbox.failed.length) { c.level = 'fail'; c.lines.push(`Failed (${f.inbox.failed.length}): ${first(f.inbox.failed).join('; ')}`); c.todo = 'Open the Inbox page; a failed file is kept in inbox/failed.' }
      if (f.inbox.held.length) { if (c.level === 'ok') c.level = 'warn'; c.lines.push(`Held by the quality gate (${f.inbox.held.length}), waiting for your decision: ${first(f.inbox.held).join('; ')}`); c.todo ??= 'Open the Inbox page and decide on each held file; its real bytes are only in inbox/held.' }
    }
    checks.push(c)
  }

  // 5. archive
  {
    const c: Check = { id: 'archive', title: 'Archive (compressed copy of every imported file)', level: 'ok', summary: '', lines: [] }
    const a = f.archive.status
    if (f.archive.timerActive === false) { c.level = 'fail'; c.summary = 'The archive timer is not running.'; c.todo = `systemctl --user enable --now ${ARCHIVE_TIMER}` }
    else if (!a) { c.level = 'warn'; c.summary = 'The archive has not reported yet.' }
    else {
      const age = f.nowMs - Date.parse(a.at)
      c.summary = `Last check ${ago(age)}: ${a.unarchived_files === 0 ? 'every imported file is archived' : `${plural(a.unarchived_files, 'file')} waiting for the next run (it runs after 20 quiet minutes)`}.`
      if (a.failed > 0 || (a.verify?.failed ?? 0) > 0) { c.level = 'fail'; c.lines.push('An archive or its sample check failed on the last run.'); c.todo = 'journalctl --user -u ulp-archive-auto.service -n 40' }
      else if (age > 3 * 3600_000) { c.level = 'warn'; c.lines.push('The archive has not been checked for over 3 hours.') }
      if (a.ready_files > 0) c.lines.push(`Ready to replace: ${plural(a.ready_files, 'file')} in inbox/done; removing their plaintext would free about ${gib(a.ready_bytes)} GiB. Your decision (archive --replace).`)
    }
    checks.push(c)
  }

  // 6. ledger copy
  {
    const c: Check = { id: 'ledger', title: 'Ledger copy (what is already ingested)', level: 'ok', summary: '', lines: [] }
    if (f.ledger.ageMs === null) { c.level = 'fail'; c.summary = 'There is no ledger copy; nothing can be recognised as already ingested.'; c.todo = 'npx tsx scripts/ledger-export.ts' }
    else if (f.ledger.ageMs > 2 * 3600_000) { c.level = 'warn'; c.summary = `${plural(f.ledger.lines, 'file')} known; the copy is ${ago(f.ledger.ageMs)} old (it refreshes on every pass that finds a new file, and every 30 minutes).`; c.todo = 'npx tsx scripts/ledger-export.ts' }
    else c.summary = `${plural(f.ledger.lines, 'file')} known; copy refreshed ${ago(f.ledger.ageMs)}.`
    checks.push(c)
  }

  // 7. disk
  {
    const c: Check = { id: 'disk', title: 'Disk', level: 'ok', summary: '', lines: [] }
    if (f.diskFreeBytes === null) { c.level = 'warn'; c.summary = 'Free disk could not be read.' }
    else {
      const g = f.diskFreeBytes / GiB
      c.summary = `${gib(f.diskFreeBytes)} GiB free.`
      if (g < DISK_FAIL_GIB) { c.level = 'fail'; c.summary += ` Below ${DISK_FAIL_GIB} GiB the import pauses.`; c.todo = 'Free space: archive --replace removes archived originals from inbox/done.' }
      else if (g < DISK_WARN_GIB) { c.level = 'warn'; c.summary += ` Below ${DISK_WARN_GIB} GiB the heavy jobs refuse to start; a big batch dips it further.` }
    }
    checks.push(c)
  }

  const fails = checks.filter(c => c.level === 'fail'), warns = checks.filter(c => c.level === 'warn')
  const level: Level = fails.length ? 'fail' : warns.length ? 'warn' : 'ok'
  const headline = level === 'ok' ? 'Fully working' : level === 'warn' ? `Working, ${plural(warns.length, 'thing')} need${warns.length === 1 ? 's' : ''} you` : `Broken: ${fails.map(c => c.title.split(':')[0].split(' (')[0]).join(', ')}`
  return { level, headline, checks }
}

// ── pages ───────────────────────────────────────────────────────────────────────────────────────────────

const MARK: Record<Level, string> = { ok: '✔', warn: '!', fail: '✖' }

export function renderText(f: PipelineFacts, v: Verdict): string {
  const at = new Date(f.nowMs).toLocaleString('sv-SE').replace('T', ' ')
  const out: string[] = [`ULP PIPELINE: ${v.headline.toUpperCase()}`, `as of ${at}`, '', 'AyuGram download -> mover -> inbox -> import -> archive; a stand-in stays in Downloads', '']
  for (const c of v.checks) {
    out.push(`[${MARK[c.level]}] ${c.title}`, `    ${c.summary}`)
    for (const l of c.lines) out.push(`    - ${l}`)
    if (c.todo && c.level !== 'ok') out.push(`    To do: ${c.todo}`)
    out.push('')
  }
  const t = f.lastThrough
  out.push(t ? `Last file through the whole pipeline: "${t.name}" moved ${t.movedAt.replace('T', ' ').slice(0, 16)} UTC, imported ${t.importedAt ? t.importedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '?'}, ${t.archived ? 'archived' : 'not archived yet'}.` : 'No file has gone through the whole pipeline yet.')
  return out.join('\n') + '\n'
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderHtml(f: PipelineFacts, v: Verdict): string {
  const at = new Date(f.nowMs).toLocaleString('sv-SE')
  const t = f.lastThrough
  const rows = v.checks.map(c => `
    <section class="check ${c.level}">
      <div class="dot" aria-hidden="true">${MARK[c.level]}</div>
      <div class="body">
        <h2>${esc(c.title)}</h2>
        <p>${esc(c.summary)}</p>
        ${c.lines.length ? `<ul>${c.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
        ${c.todo && c.level !== 'ok' ? `<p class="todo"><b>To do:</b> <code>${esc(c.todo)}</code></p>` : ''}
      </div>
    </section>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>ULP Pipeline Status</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#5d6471;--line:#dfe3ea;--ok:#1a7f45;--okbg:#e6f5ec;--warn:#9a6200;--warnbg:#fff3d6;--fail:#b3261e;--failbg:#fde7e5;--code:#eef0f4}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1115;--card:#171a21;--ink:#e8eaf0;--mute:#9aa3b2;--line:#2a2f3a;--ok:#4cc27f;--okbg:#12281c;--warn:#f0b44c;--warnbg:#2b2210;--fail:#ff7b72;--failbg:#2f1513;--code:#222733}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
.banner{border-radius:14px;padding:20px 22px;margin-bottom:18px;border:1px solid var(--line)}
.banner.ok{background:var(--okbg);color:var(--ok)}.banner.warn{background:var(--warnbg);color:var(--warn)}.banner.fail{background:var(--failbg);color:var(--fail)}
.banner h1{margin:0;font-size:1.6rem}.banner p{margin:.3rem 0 0;color:var(--mute);font-size:.92rem}
.flow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 18px;color:var(--mute);font-size:.9rem}.flow span{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.check{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-left-width:6px;border-radius:12px;padding:14px 16px;margin-bottom:10px}
.check.ok{border-left-color:var(--ok)}.check.warn{border-left-color:var(--warn)}.check.fail{border-left-color:var(--fail)}
.dot{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#fff}
.ok .dot{background:var(--ok)}.warn .dot{background:var(--warn)}.fail .dot{background:var(--fail)}
.body{min-width:0}h2{margin:0;font-size:1.02rem}.body p{margin:.25rem 0 0}.body ul{margin:.4rem 0 0;padding-left:1.2rem;color:var(--mute);font-size:.92rem;overflow-wrap:anywhere}
.todo{font-size:.92rem}code{background:var(--code);border-radius:6px;padding:1px 6px;font-size:.86rem;overflow-wrap:anywhere}
.last{margin-top:16px;color:var(--mute);font-size:.92rem}footer{margin-top:22px;color:var(--mute);font-size:.82rem}
</style></head><body><main>
<div class="banner ${v.level}"><h1>${MARK[v.level]} ${esc(v.headline)}</h1><p>As of ${esc(at)} · this page refreshes by itself every 30 seconds</p></div>
<div class="flow"><span>Download in AyuGram</span>→<span>Mover (waits until the file is closed)</span>→<span>Inbox</span>→<span>Import</span>→<span>Archive</span><span>+ a stand-in stays in Downloads</span></div>
${rows}
<p class="last">${t ? `Last file through the whole pipeline: <b>${esc(t.name)}</b> — moved ${esc(t.movedAt.replace('T', ' ').slice(0, 16))} UTC, imported ${esc(t.importedAt ? t.importedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '?')}, ${t.archived ? 'archived' : 'not archived yet'}.` : 'No file has gone through the whole pipeline yet.'}</p>
<footer>Folder map: downloads ${esc(f.paths.downloads)} · inbox ${esc(f.paths.inbox)} · archive ${esc(f.paths.archive)} · this folder ${esc(f.paths.pipeline)}</footer>
</main></body></html>
`
}

/** The README the pipeline folder carries: what each thing in it is and what runs. Static apart from the paths. */
export function renderReadme(f: PipelineFacts): string {
  return `ULP PIPELINE: how it works and where things are
================================================

Open STATUS.html in a browser: one banner says whether everything works (green), works but needs you (amber) or is broken (red). It refreshes every minute on its own.
STATUS.txt is the same in plain text. In a terminal: cd ${f.paths.inbox.replace(/\/inbox$/, '')} && npx tsx scripts/pipeline-status.ts

What happens to a download
  1. You download a file in AyuGram. It lands in   ${f.paths.downloads}
  2. Every minute the MOVER looks at that folder. A .txt of 1 MB or more is moved only when it is FINISHED: no program has it open (AyuGram holds a file open
     for the whole download and closes it when the last part is in), it has not changed for 3 minutes, and no part of it is missing.
  3. The moved file goes to   ${f.paths.inbox}   and the importer takes it by itself.
  4. In the Downloads folder a STAND-IN takes its place: same name, size and modification time, no disk space. That is why AyuGram keeps showing the message as
     downloaded, also after a restart or a reboot. Never delete a stand-in you want AyuGram to remember.
  5. Once the inbox has been quiet for 20 minutes the files in inbox/done are archived (compressed, verified) in   ${f.paths.archive}
  6. Removing the big originals from inbox/done is still your decision (archive --replace); STATUS says how much it would free.

Files in this folder
  STATUS.html / STATUS.txt   the status pages (rewritten every minute)
  ledger.tsv                 every file ever imported: name, size, sha256, rows, when. Search it (grep) before you download something.
  stand-ins.tsv              the stand-ins that were made (so one can be checked or restored)
  hashes.json                remembered file hashes (so a big file is read once)
  last-run.json              what the mover did on its last run

If something looks wrong
  Amber "held" file: the quality gate stopped a file; open the Inbox page and decide. Its bytes are in ${f.paths.inbox}/held.
  Red "mover": systemctl --user status ulp-pull-downloads.timer ; journalctl --user -u ulp-pull-downloads.service -n 30
  Switch the mover off:  ULP_MOVER=off  (in the unit's environment). Switch only the stand-in part off: ULP_STANDIN_SWEEP=off.
  Put a file's real bytes back from the archive:  npx tsx scripts/stand-in-sweep.ts --restore "<path to the stand-in>"
`
}

/** Writes STATUS.html, STATUS.txt and README.txt into the pipeline folder; returns the verdict. */
export function writeStatusFiles(f: PipelineFacts): Verdict {
  const v = evaluate(f)
  const put = (name: string, text: string): void => {
    const path = join(f.paths.pipeline, name)
    writeFileSync(`${path}.part`, text)
    renameSync(`${path}.part`, path)
  }
  put('STATUS.html', renderHtml(f, v))
  put('STATUS.txt', renderText(f, v))
  put('README.txt', renderReadme(f))
  return v
}
