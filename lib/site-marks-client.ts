/**
 * The page's side of the site marks: what it knows, what it asked for and what it is still saving (design: docs/superpowers/specs/2026-10-29-site-marks-design.md).
 * Plain TypeScript with no React in it, so the order of the saves and the way back from a failed one are tested with a fake `fetch`; the page reads it
 * with useSyncExternalStore.
 *
 * - load(hosts) asks once for the marks of a whole list. Until the answer the status is 'loading', and a failure is 'failed': the page never shows a
 *   mark it could not load as "No mark" (a person could save over a note they cannot see), and nothing is saved before the marks are loaded.
 * - change(host, patch) shows the change at once and sends it. The changes to one site go one after the other, so the stored state is the last click's;
 *   the answer of the last one replaces what is shown (the server's word, not the page's guess), and if it fails the site goes back to what the server
 *   last said and onSaveFailed tells the person. An earlier answer of a site that has a later change on its way is not shown: it would put back a
 *   state the later click has already replaced.
 */
import { mergeMark, type SiteMark, type SiteMarkPatch } from '@/lib/site-marks-input'

export type MarksStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface MarksSnapshot {
  status: MarksStatus
  /** Only the sites that have a mark. */
  marks: Readonly<Record<string, SiteMark>>
  /** Why the marks did not load, when the status is 'failed'. */
  error: string | null
}

export interface SiteMarksStoreDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  /** A save did not go through: a sentence for the person. */
  onSaveFailed: (message: string) => void
}

const ENDPOINT = '/api/lookup/marks'
export const SESSION_EXPIRED = 'Your session has expired. Sign in again, then try again.'

interface MarksAnswer {
  success?: boolean
  marks?: Record<string, SiteMark>
  mark?: SiteMark | null
  error?: string
}

async function ask(send: SiteMarksStoreDeps['fetch'], method: 'POST' | 'PUT', body: unknown): Promise<MarksAnswer> {
  let res: Response
  try {
    res = await send(ENDPOINT, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('Could not reach the server')
  }
  // An expired session is redirected to the sign-in page, which is not JSON.
  if (res.redirected || res.status === 401) throw new Error(SESSION_EXPIRED)
  let json: MarksAnswer
  try {
    json = await res.json()
  } catch {
    throw new Error('The server did not answer properly')
  }
  if (!json.success) throw new Error(json.error || 'The request failed')
  return json
}

export function createSiteMarksStore(deps: SiteMarksStoreDeps) {
  let snapshot: MarksSnapshot = { status: 'idle', marks: {}, error: null }
  let generation = 0 // a load that is not the latest one is ignored
  let lastHosts: string[] = []
  const listeners = new Set<() => void>()
  const confirmed = new Map<string, SiteMark>() // what the server last said, per site: only the sites that have a mark
  const pending = new Map<string, number>() // changes of a site that are being sent or are waiting
  const tails = new Map<string, Promise<void>>() // the last of them: the next one waits for it

  const publish = (next: MarksSnapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }

  const setMark = (host: string, mark: SiteMark | null) => {
    const marks = { ...snapshot.marks }
    if (mark === null) delete marks[host]
    else marks[host] = mark
    publish({ ...snapshot, marks })
  }

  async function load(hosts: string[]): Promise<void> {
    const mine = ++generation
    lastHosts = hosts
    confirmed.clear()
    if (hosts.length === 0) {
      publish({ status: 'ready', marks: {}, error: null })
      return
    }
    publish({ status: 'loading', marks: {}, error: null })
    try {
      const answer = await ask(deps.fetch, 'POST', { hosts })
      if (mine !== generation) return
      const marks = answer.marks ?? {}
      for (const [host, mark] of Object.entries(marks)) confirmed.set(host, mark)
      publish({ status: 'ready', marks, error: null })
    } catch (error) {
      if (mine !== generation) return
      publish({ status: 'failed', marks: {}, error: error instanceof Error ? error.message : 'The marks could not be loaded' })
    }
  }

  function change(host: string, patch: SiteMarkPatch): Promise<void> {
    if (snapshot.status !== 'ready') return Promise.resolve()
    const current = snapshot.marks[host] ?? null
    const merged = mergeMark(current, patch)
    // Shown at once; the server's answer replaces it. Who and when stay those of the last real change until the server says otherwise.
    setMark(host, merged === null ? null : { ...merged, updated_by: current?.updated_by ?? null, updated_at: current?.updated_at ?? null })
    pending.set(host, (pending.get(host) ?? 0) + 1)
    /** Counts this change as done; true when it was the last one of the site. */
    const finish = () => {
      const left = (pending.get(host) ?? 1) - 1
      if (left === 0) pending.delete(host)
      else pending.set(host, left)
      return left === 0
    }

    const run = (tails.get(host) ?? Promise.resolve()).then(async () => {
      try {
        const answer = await ask(deps.fetch, 'PUT', { host, ...patch })
        const stored = answer.mark ?? null
        if (stored === null) confirmed.delete(host)
        else confirmed.set(host, stored)
        if (finish()) setMark(host, stored)
      } catch (error) {
        if (finish()) setMark(host, confirmed.get(host) ?? null)
        deps.onSaveFailed(error instanceof Error ? error.message : 'The mark was not saved')
      }
    })
    tails.set(host, run)
    void run.then(() => {
      if (tails.get(host) === run) tails.delete(host)
    })
    return run
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    load,
    /** Asks again for the hosts of the last load: the Retry of a failed one. */
    retry: () => load(lastHosts),
    change,
  }
}

export type SiteMarksStore = ReturnType<typeof createSiteMarksStore>
