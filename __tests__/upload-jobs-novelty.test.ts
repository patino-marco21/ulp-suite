import { describe, expect, it } from 'vitest'
import { createJob, getJob, pushEvent, updateJob } from '@/lib/upload-jobs'

function fakeWriter() {
  const sent: string[] = []
  const decoder = new TextDecoder()
  let closed = false
  const writer = {
    write: async (chunk: Uint8Array) => { sent.push(decoder.decode(chunk)) },
    close: async () => { closed = true },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>
  const events = () => sent.map(s => JSON.parse(s.replace(/^data: /, '').trim()))
  return { writer, events, isClosed: () => closed }
}

describe('upload job: novelty-aware ingest fields', () => {
  it('starts with nothing known, staged or repeated and no phase', () => {
    const job = createJob('job-a', 1000, 'Breach')
    expect(job).toMatchObject({ known: 0, inFileDuplicates: 0, staged: 0, imported: 0 })
    expect(job.phase).toBeUndefined()
  })

  it('reports the phase and the staged rows while parsing, and takes the percentage from the staged rows', async () => {
    const job = createJob('job-b', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-b', { phase: 'parsing', staged: 250, skipped: 3 })
    await pushEvent(getJob('job-b')!)
    expect(out.events()[0]).toMatchObject({ phase: 'parsing', staged: 250, skipped: 3, imported: 0, known: 0, pct: 25, status: 'running' })
  })

  it('reports the slab, the new rows and the known rows while committing', async () => {
    const job = createJob('job-c', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-c', { phase: 'inserting', staged: 1000, imported: 300, known: 200, slab: 2, slabs: 5 })
    await pushEvent(getJob('job-c')!)
    expect(out.events()[0]).toMatchObject({ phase: 'inserting', imported: 300, known: 200, slab: 2, slabs: 5, pct: 100 })
  })

  it('without a phase (the direct path) the percentage still comes from imported', async () => {
    const job = createJob('job-d', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-d', { imported: 500 })
    await pushEvent(getJob('job-d')!)
    expect(out.events()[0]).toMatchObject({ pct: 50, known: 0, inFileDuplicates: 0 })
    expect(out.events()[0].phase).toBeUndefined()
  })

  it('the final event carries the totals and closes the stream', async () => {
    const job = createJob('job-e', 1000, 'Breach')
    const out = fakeWriter()
    job.writer = out.writer
    updateJob('job-e', { status: 'done', phase: undefined, imported: 600, known: 300, inFileDuplicates: 100, skipped: 7 })
    await pushEvent(getJob('job-e')!)
    expect(out.events()[0]).toMatchObject({ status: 'done', imported: 600, known: 300, inFileDuplicates: 100, skipped: 7 })
    expect(out.isClosed()).toBe(true)
  })
})
