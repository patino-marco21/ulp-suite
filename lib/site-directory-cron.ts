/**
 * Keeps the Site Directory current (design: docs/superpowers/specs/2026-11-21-site-directory-design.md, "Staying current"). The signal is the one the
 * search dictionary already uses: the fingerprint of the live table (lib/search-dictionary.ts, readLiveState), which changes on an import, a delete, a
 * dedup or a partition swap and not on a merge. A site is out of date when the fingerprint stored with its numbers is not the present one, or when it was
 * never counted all-time.
 *
 * One tick every SITE_DIRECTORY_CRON_MINUTES (default 10; 0 disables). With nothing out of date a tick costs one SQLite query and one metadata query.
 * Otherwise, like the dictionary's tick: it waits while an import is queued or running (the shared upload queue) or a content mutation runs, reads the
 * fingerprint, waits SITE_DIRECTORY_SETTLE_SECONDS (default 120) and reads it again, so a big file whose commits are minutes apart is never counted against
 * (a quiet moment inside a batch would be out of date on arrival). Then it recounts the out-of-date sites, biggest first, 100 at a time through
 * countSites (so the chunks of 20, the time limit and the too-broad fallback are those of the counts), storing each answer against the fingerprint read
 * after the wait, and works out again the splits that exist. It stops at once when an import starts. Failures back off: three in a row wait an hour.
 *
 * Production only (instrumentation.ts). A tick never overlaps the previous one.
 */
import { readLiveState, type LiveState } from '@/lib/search-dictionary'
import { countSites } from '@/lib/site-counts'
import type { SiteCount } from '@/lib/site-counts-input'
import {
  breakdownTargets, directoryTotal, outOfDateHosts, seedFromMarks, staleCount, storeCounts, touchBreakdown,
} from '@/lib/site-directory'
import { breakdownAndStore } from '@/lib/site-directory-breakdown'
import { refreshState } from '@/lib/site-directory-state'
import { queueSize } from '@/lib/upload-queue'

type Env = Record<string, string | undefined>

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export const siteDirectoryCronMinutes = (env: Env = process.env): number => envInt(env.SITE_DIRECTORY_CRON_MINUTES, 10)
export const siteDirectorySettleSeconds = (env: Env = process.env): number => envInt(env.SITE_DIRECTORY_SETTLE_SECONDS, 120)

export type TickOutcome = 'disabled' | 'fresh' | 'unknown' | 'importing' | 'mutating' | 'settling' | 'no-projection' | 'backoff' | 'refreshed' | 'failed'

export interface TickDeps {
  seed: () => number
  live: () => Promise<LiveState | null>
  /** True while an import (an inbox file or an upload) is queued or running. */
  importing: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Sites whose count or split is out of date against this fingerprint. */
  stale: (fingerprint: string) => number
  outOfDate: (fingerprint: string, limit: number) => string[]
  count: (hosts: string[]) => Promise<{ results: Record<string, SiteCount>; subdomains_counted: boolean }>
  store: (results: Record<string, SiteCount>, fingerprint: string) => void
  breakdownTargets: (fingerprint: string, limit: number) => string[]
  breakdown: (host: string, fingerprint: string) => Promise<void>
  touchBreakdown: (host: string, fingerprint: string) => void
}

const BATCH = 100
const MAX_BATCHES = 200
const TICK_BUDGET_MS = 10 * 60_000
const MAX_BREAKDOWNS = 50
const BACKOFF_AFTER_FAILURES = 3
const BACKOFF_MS = 3_600_000
const FIRST_TICK_MS = 120_000

let failures = 0
let lastFailureAt = 0
let started = false

export function resetCronState(): void {
  failures = 0
  lastFailureAt = 0
  started = false
}

const defaultDeps = (): TickDeps => ({
  seed: seedFromMarks,
  live: () => readLiveState(),
  importing: () => queueSize() > 0,
  sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
  now: Date.now,
  stale: staleCount,
  outOfDate: outOfDateHosts,
  count: hosts => countSites(hosts, { lower: null, upper: null }),
  store: storeCounts,
  breakdownTargets,
  breakdown: (host, fingerprint) => breakdownAndStore(host, fingerprint),
  touchBreakdown,
})

export async function runSiteDirectoryTick(overrides: Partial<TickDeps> = {}): Promise<TickOutcome> {
  if (siteDirectoryCronMinutes() <= 0) return 'disabled'
  const d: TickDeps = { ...defaultDeps(), ...overrides }

  d.seed()
  const first = await d.live()
  if (!first) return 'unknown'
  if (d.stale(first.fingerprint) === 0) return 'fresh'
  if (failures >= BACKOFF_AFTER_FAILURES && d.now() - lastFailureAt < BACKOFF_MS) return 'backoff'
  if (d.importing()) return 'importing'
  if (first.mutationsRunning > 0) return 'mutating'
  await d.sleep(siteDirectorySettleSeconds() * 1000)
  const second = await d.live()
  if (!second) return 'unknown'
  if (second.fingerprint !== first.fingerprint) return 'settling'
  if (second.mutationsRunning > 0) return 'mutating'
  if (d.importing()) return 'importing' // a file was claimed while the tick waited
  return refresh(d, second.fingerprint)
}

async function refresh(d: TickDeps, fingerprint: string): Promise<TickOutcome> {
  refreshState.running = true
  try {
    const startedAt = d.now()
    let previous = ''
    for (let batch = 0; batch < MAX_BATCHES && d.now() - startedAt <= TICK_BUDGET_MS; batch++) {
      if (d.importing()) return 'importing'
      const hosts = d.outOfDate(fingerprint, BATCH)
      if (hosts.length === 0) break
      const key = hosts.join(',')
      if (key === previous) break // nothing could be stored for them: do not spin
      previous = key
      const { results, subdomains_counted } = await d.count(hosts)
      if (!subdomains_counted) return 'no-projection' // hosts only: storing it would put a smaller number in every row
      d.store(results, fingerprint)
    }
    for (const host of d.breakdownTargets(fingerprint, MAX_BREAKDOWNS)) {
      if (d.importing()) return 'importing'
      try {
        await d.breakdown(host, fingerprint)
      } catch {
        d.touchBreakdown(host, fingerprint) // keeps its numbers; tried again when the table changes
      }
    }
    failures = 0
    refreshState.lastRefreshedAt = new Date(d.now()).toISOString()
    console.warn(`[site-directory] tick refreshed the directory (fingerprint ${fingerprint.slice(0, 12)})`)
    return 'refreshed'
  } catch (err) {
    failures += 1
    lastFailureAt = d.now()
    console.error('[site-directory] refresh failed:', err)
    return 'failed'
  } finally {
    refreshState.running = false
  }
}

export function startSiteDirectoryCron(): void {
  if (started) return
  const minutes = siteDirectoryCronMinutes()
  if (minutes <= 0) {
    console.log('[site-directory] cron disabled (SITE_DIRECTORY_CRON_MINUTES=0)')
    return
  }
  started = true
  const everyMs = minutes * 60_000
  const firstMs = Math.min(FIRST_TICK_MS, everyMs)
  let running = false
  const tick = () => {
    if (running) return
    running = true
    runSiteDirectoryTick()
      .catch(err => console.error('[site-directory] tick failed:', err))
      .finally(() => { running = false })
  }
  console.warn(`[site-directory] cron started — first tick in ${Math.round(firstMs / 1000)}s, then every ${minutes}m`)
  setTimeout(tick, firstMs)
  setInterval(tick, everyMs)
}

export interface StatusDeps {
  live: () => Promise<LiveState | null>
  stale: (fingerprint: string) => number
  total: () => number
}

/** GET /api/lookup/directory/status: how many sites are out of date and what the refresh is doing, for the line above the list. */
export async function answerDirectoryStatus(overrides: Partial<StatusDeps> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const d: StatusDeps = { live: () => readLiveState(), stale: staleCount, total: directoryTotal, ...overrides }
  try {
    const live = await d.live()
    const outOfDate = live ? d.stale(live.fingerprint) : 0
    const state = refreshState.running ? 'refreshing' : outOfDate > 0 ? 'waiting' : 'current'
    return { status: 200, json: { success: true, total: d.total(), out_of_date: outOfDate, state, refreshed_at: refreshState.lastRefreshedAt } }
  } catch (error) {
    console.error('site directory status error:', error)
    return { status: 500, json: { success: false, error: 'Reading the status failed' } }
  }
}
