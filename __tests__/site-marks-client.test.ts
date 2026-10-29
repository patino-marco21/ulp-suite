import { describe, test, expect, vi } from 'vitest'
import { SESSION_EXPIRED, createSiteMarksStore } from '@/lib/site-marks-client'
import type { SiteMark } from '@/lib/site-marks-input'

const mark = (status: SiteMark['status'], note: string | null = null, by: string | null = 'a@example.test'): SiteMark => ({
  status, note, updated_by: by, updated_at: '2026-10-29 10:00:00',
})
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A fetch that answers when the test says so, and remembers what it was asked. */
function controlledFetch() {
  const requests: Array<{ method: string; body: Record<string, unknown>; answer: (res: Response) => void; fail: (err: Error) => void }> = []
  const fetch = (_input: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      requests.push({ method: String(init.method), body: JSON.parse(String(init.body)), answer: resolve, fail: reject })
    })
  return { fetch, requests }
}

/** A store whose first load is already answered with `initial`. */
async function loadedStore(initial: Record<string, SiteMark> = {}) {
  const net = controlledFetch()
  const failures: string[] = []
  const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: message => failures.push(message) })
  const hosts = Object.keys(initial).length > 0 ? Object.keys(initial) : ['placeholder.example']
  const loading = store.load(hosts)
  net.requests[0].answer(reply({ success: true, marks: initial }))
  await loading
  return { ...net, failures, store, shown: (host: string) => store.getSnapshot().marks[host] }
}

function freshStore() {
  const net = controlledFetch()
  const failures: string[] = []
  const store = createSiteMarksStore({ fetch: net.fetch, onSaveFailed: message => failures.push(message) })
  return { ...net, failures, store }
}

describe('load', () => {
  test('asks for the marks of the whole list in one request, and shows them when they arrive', async () => {
    const t = freshStore()
    expect(t.store.getSnapshot()).toEqual({ status: 'idle', marks: {}, error: null })
    const loading = t.store.load(['a.example', 'b.example'])
    expect(t.store.getSnapshot()).toEqual({ status: 'loading', marks: {}, error: null })
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]).toMatchObject({ method: 'POST', body: { hosts: ['a.example', 'b.example'] } })
    t.requests[0].answer(reply({ success: true, marks: { 'a.example': mark('done') } }))
    await loading
    expect(t.store.getSnapshot()).toEqual({ status: 'ready', marks: { 'a.example': mark('done') }, error: null })
  })

  test('with no host there is nothing to ask: ready, with no marks', async () => {
    const t = freshStore()
    await t.store.load([])
    expect(t.requests).toHaveLength(0)
    expect(t.store.getSnapshot()).toEqual({ status: 'ready', marks: {}, error: null })
  })

  test('a load that fails is failed, with the reason and no marks, never an empty ready: Retry asks again for the same hosts', async () => {
    const t = freshStore()
    const loading = t.store.load(['a.example'])
    t.requests[0].answer(reply({ success: false, error: 'Reading the marks failed' }, 500))
    await loading
    expect(t.store.getSnapshot()).toEqual({ status: 'failed', marks: {}, error: 'Reading the marks failed' })

    const again = t.store.retry()
    expect(t.store.getSnapshot().status).toBe('loading')
    expect(t.requests[1]).toMatchObject({ method: 'POST', body: { hosts: ['a.example'] } })
    t.requests[1].answer(reply({ success: true, marks: { 'a.example': mark('skip') } }))
    await again
    expect(t.store.getSnapshot()).toEqual({ status: 'ready', marks: { 'a.example': mark('skip') }, error: null })
  })

  test('a network failure, an answer that is not JSON and an expired session each fail with a sentence', async () => {
    const t = freshStore()
    const down = t.store.load(['a.example'])
    t.requests[0].fail(new Error('connect ECONNREFUSED'))
    await down
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: 'Could not reach the server' })

    const html = t.store.load(['a.example'])
    t.requests[1].answer(new Response('<html>502</html>', { status: 502 }))
    await html
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: 'The server did not answer properly' })

    const expired = t.store.load(['a.example'])
    t.requests[2].answer(reply({}, 401))
    await expired
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: SESSION_EXPIRED })

    const redirected = t.store.load(['a.example'])
    t.requests[3].answer(Object.defineProperty(new Response('<html>sign in</html>'), 'redirected', { value: true }))
    await redirected
    expect(t.store.getSnapshot()).toMatchObject({ status: 'failed', error: SESSION_EXPIRED })
  })

  test('an older load that answers late is ignored', async () => {
    const t = freshStore()
    const first = t.store.load(['a.example'])
    const second = t.store.load(['b.example'])
    t.requests[1].answer(reply({ success: true, marks: { 'b.example': mark('todo') } }))
    await second
    t.requests[0].answer(reply({ success: true, marks: { 'a.example': mark('done') } }))
    await first
    expect(t.store.getSnapshot().marks).toEqual({ 'b.example': mark('todo') })
  })

  test('listeners hear every change of the snapshot until they unsubscribe', async () => {
    const t = freshStore()
    const heard = vi.fn()
    const unsubscribe = t.store.subscribe(heard)
    await t.store.load([])
    expect(heard).toHaveBeenCalledTimes(1)
    unsubscribe()
    await t.store.load([])
    expect(heard).toHaveBeenCalledTimes(1)
  })

  test('the snapshot is the same object until something changes, which useSyncExternalStore needs', async () => {
    const t = freshStore()
    await t.store.load([])
    expect(t.store.getSnapshot()).toBe(t.store.getSnapshot())
  })
})

describe('change', () => {
  test('shows the change at once, sends only what changed, then shows what the server stored', async () => {
    const t = await loadedStore({ 'a.example': mark('done', 'old') })
    const saving = t.store.change('a.example', { status: 'skip' })
    // at once, with the name and time of the last real change until the server answers
    expect(t.shown('a.example')).toEqual({ status: 'skip', note: 'old', updated_by: 'a@example.test', updated_at: '2026-10-29 10:00:00' })
    await flush()
    expect(t.requests).toHaveLength(2)
    expect(t.requests[1]).toMatchObject({ method: 'PUT', body: { host: 'a.example', status: 'skip' } })
    expect(t.requests[1].body).not.toHaveProperty('note')
    t.requests[1].answer(reply({ success: true, host: 'a.example', mark: mark('skip', 'old', 'b@example.test') }))
    await saving
    expect(t.shown('a.example')).toEqual(mark('skip', 'old', 'b@example.test'))
  })

  test('a note alone keeps the status on screen, and clearing both takes the mark away at once', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    void t.store.change('a.example', { note: '  looked at it ' })
    expect(t.shown('a.example')).toMatchObject({ status: 'done', note: 'looked at it' })
    void t.store.change('a.example', { status: null, note: null })
    expect(t.shown('a.example')).toBeUndefined()
  })

  test('a site with no mark gets one at once, with no name or time until the server answers', async () => {
    const t = await loadedStore({})
    void t.store.change('new.example', { status: 'todo' })
    expect(t.shown('new.example')).toEqual({ status: 'todo', note: null, updated_by: null, updated_at: null })
  })

  test('a save that fails puts back what the server last said, and tells the person why', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    const saving = t.store.change('a.example', { status: 'skip' })
    await flush()
    t.requests[1].answer(reply({ success: false, error: 'Saving the mark failed' }, 500))
    await saving
    expect(t.shown('a.example')).toEqual(mark('done'))
    expect(t.failures).toEqual(['Saving the mark failed'])
  })

  test('a save that fails for a site that had no mark takes the mark it showed away again', async () => {
    const t = await loadedStore({})
    const saving = t.store.change('new.example', { status: 'todo' })
    await flush()
    t.requests[1].fail(new Error('offline'))
    await saving
    expect(t.shown('new.example')).toBeUndefined()
    expect(t.failures).toEqual(['Could not reach the server'])
  })

  test('an expired session says so', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    const saving = t.store.change('a.example', { status: 'skip' })
    await flush()
    t.requests[1].answer(reply({}, 401))
    await saving
    expect(t.failures).toEqual([SESSION_EXPIRED])
    expect(t.shown('a.example')).toEqual(mark('done'))
  })

  test('the changes to one site go one after the other, and the answer of an earlier one does not put its state back over a later click', async () => {
    const t = await loadedStore({})
    const first = t.store.change('a.example', { status: 'done' })
    const second = t.store.change('a.example', { status: 'skip' })
    await flush()
    // only the first is on its way; the second waits for it
    expect(t.requests.slice(1).map(r => r.body)).toEqual([{ host: 'a.example', status: 'done' }])
    expect(t.shown('a.example')?.status).toBe('skip')

    t.requests[1].answer(reply({ success: true, host: 'a.example', mark: mark('done') }))
    await flush()
    expect(t.requests.slice(1).map(r => r.body)).toEqual([{ host: 'a.example', status: 'done' }, { host: 'a.example', status: 'skip' }])
    expect(t.shown('a.example')?.status).toBe('skip') // not 'done': the later click has replaced it

    t.requests[2].answer(reply({ success: true, host: 'a.example', mark: mark('skip', null, 'b@example.test') }))
    await Promise.all([first, second])
    expect(t.shown('a.example')).toEqual(mark('skip', null, 'b@example.test'))
  })

  test('a change that failed does not roll back a later one still on its way; the later answer settles the site', async () => {
    const t = await loadedStore({})
    const first = t.store.change('a.example', { status: 'done' })
    const second = t.store.change('a.example', { note: 'n' })
    await flush()
    t.requests[1].answer(reply({ success: false, error: 'Saving the mark failed' }, 500))
    await flush()
    expect(t.failures).toEqual(['Saving the mark failed'])
    expect(t.shown('a.example')).toMatchObject({ status: 'done', note: 'n' }) // still what the person last did
    t.requests[2].answer(reply({ success: true, host: 'a.example', mark: mark(null, 'n') })) // the first never reached the server
    await Promise.all([first, second])
    expect(t.shown('a.example')).toEqual(mark(null, 'n'))
  })

  test('changes to different sites are not held up by one another', async () => {
    const t = await loadedStore({})
    void t.store.change('a.example', { status: 'done' })
    void t.store.change('b.example', { status: 'skip' })
    await flush()
    expect(t.requests.slice(1).map(r => r.body)).toEqual([{ host: 'a.example', status: 'done' }, { host: 'b.example', status: 'skip' }])
  })

  test('nothing is sent before the marks are loaded, while they load, or after they failed', async () => {
    const t = freshStore()
    await t.store.change('a.example', { status: 'done' })
    expect(t.requests).toHaveLength(0)
    expect(t.store.getSnapshot().marks).toEqual({})

    const loading = t.store.load(['a.example'])
    await t.store.change('a.example', { status: 'done' })
    expect(t.requests).toHaveLength(1) // only the load
    t.requests[0].answer(reply({ success: false, error: 'boom' }, 500))
    await loading
    await t.store.change('a.example', { status: 'done' })
    expect(t.requests).toHaveLength(1)
    expect(t.store.getSnapshot().marks).toEqual({})
  })

  test('loading again forgets what the server last said about the old list: a failed save goes back to the new answer', async () => {
    const t = await loadedStore({ 'a.example': mark('done') })
    const reload = t.store.load(['a.example'])
    t.requests[1].answer(reply({ success: true, marks: { 'a.example': mark('skip') } }))
    await reload
    const saving = t.store.change('a.example', { status: 'todo' })
    await flush()
    t.requests[2].answer(reply({ success: false, error: 'Saving the mark failed' }, 500))
    await saving
    expect(t.shown('a.example')).toEqual(mark('skip'))
  })
})
