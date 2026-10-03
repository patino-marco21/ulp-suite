/**
 * Keeps the search dictionary (lib/search-dictionary.ts) current. One tick every SEARCH_DICT_CRON_MINUTES (default 10; 0 disables). A tick rebuilds only
 * when the dictionary is stale or missing AND the table has been quiet: the fingerprint is read, the tick waits SEARCH_DICT_SETTLE_SECONDS (default
 * 120) and reads it again, so an import in progress is never built against. It also skips while a content mutation or another build is running,
 * and when the disk has no room for the second copy (not a failure). Failures back off: three in a row wait an hour.
 *
 * Production only (instrumentation.ts). The settle wait makes a tick long, so a tick never overlaps the previous one.
 */
import {
  buildSearchDictionary, DictionaryHeadroomError, getSearchDictionaryStatus, readLiveState, resetSearchDictionaryCache, recordBuildOutcome,
  searchDictCronMinutes, searchDictSettleSeconds, searchDictionaryEnabled,
  type BuildResult, type DictionaryStatus, type LiveState,
} from '@/lib/search-dictionary'

export type TickOutcome = 'disabled' | 'fresh' | 'unknown' | 'building' | 'settling' | 'mutating' | 'backoff' | 'no-headroom' | 'built' | 'failed'

export interface TickDeps {
  status: () => Promise<DictionaryStatus>
  live: () => Promise<LiveState | null>
  build: () => Promise<BuildResult>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

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
  // the cron must not trust a cached answer (up to 3 s old): it is about to act on it
  status: async () => { resetSearchDictionaryCache(); return getSearchDictionaryStatus() },
  live: () => readLiveState(),
  build: () => buildSearchDictionary(),
  sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
  now: Date.now,
})

export async function runSearchDictionaryTick(overrides: Partial<TickDeps> = {}): Promise<TickOutcome> {
  if (!searchDictionaryEnabled()) return 'disabled'
  const d: TickDeps = { ...defaultDeps(), ...overrides }

  const status = await d.status()
  if (status.state === 'fresh') return 'fresh'
  if (status.state === 'building') return 'building'
  if (status.state === 'disabled') return 'disabled'
  if (status.state === 'unknown') return 'unknown'

  // stale or missing
  if (failures >= BACKOFF_AFTER_FAILURES && d.now() - lastFailureAt < BACKOFF_MS) return 'backoff'
  const first = await d.live()
  if (!first) return 'unknown'
  if (first.mutationsRunning > 0) return 'mutating'
  await d.sleep(searchDictSettleSeconds() * 1000)
  const second = await d.live()
  if (!second) return 'unknown'
  if (second.fingerprint !== first.fingerprint) return 'settling'
  if (second.mutationsRunning > 0) return 'mutating'
  if (second.buildsRunning > 0) return 'building'

  try {
    const result = await d.build()
    failures = 0
    console.warn(`[search-dictionary] tick built the dictionary: ${result.pairRows} host pairs, ${result.emailRows} email domains in ${Math.round(result.ms / 1000)}s`)
    return 'built'
  } catch (err) {
    if (err instanceof DictionaryHeadroomError) {
      console.warn(`[search-dictionary] build skipped: ${err.message}`)
      return 'no-headroom'
    }
    failures += 1
    lastFailureAt = d.now()
    recordBuildOutcome({ lastError: err instanceof Error ? err.message : String(err) })
    console.error('[search-dictionary] build failed:', err)
    return 'failed'
  }
}

export function startSearchDictionaryCron(): void {
  if (started) return
  const minutes = searchDictCronMinutes()
  if (minutes <= 0 || !searchDictionaryEnabled()) {
    console.log('[search-dictionary] cron disabled (SEARCH_DICT_CRON_MINUTES=0 or SEARCH_DICTIONARY=0)')
    return
  }
  started = true
  const everyMs = minutes * 60_000
  const firstMs = Math.min(FIRST_TICK_MS, everyMs)
  let running = false
  const tick = () => {
    if (running) return
    running = true
    runSearchDictionaryTick()
      .catch(err => console.error('[search-dictionary] tick failed:', err))
      .finally(() => { running = false })
  }
  console.warn(`[search-dictionary] cron started — first tick in ${Math.round(firstMs / 1000)}s, then every ${minutes}m`)
  setTimeout(tick, firstMs)
  setInterval(tick, everyMs)
}
