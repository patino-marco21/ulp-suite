import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StageJob, WorkerMessage } from '@/lib/ingest-worker-protocol'

const REPO = new URL('../', import.meta.url).pathname

let out: string
let bundle: string
beforeAll(() => { out = mkdtempSync(join(tmpdir(), 'ingest-worker-build-')); bundle = join(out, 'ingest-worker.cjs') })
afterAll(() => rmSync(out, { recursive: true, force: true }))

describe('scripts/build-ingest-worker.mjs', () => {
  it('bundles lib/ingest-worker.ts into one file', () => {
    const r = spawnSync('node', ['scripts/build-ingest-worker.mjs', '--out', bundle], { cwd: REPO, encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(statSync(bundle).size).toBeGreaterThan(50_000)
    expect(r.stdout).toMatch(/ingest-worker\.cjs/)
  }, 60_000)

  it('makes a bundle that starts in a bare worker thread and answers over the protocol', async () => {
    const job: StageJob = {
      path: join(out, 'no-such-file.txt'), filename: 'no-such-file.txt', table: 'ulp.stage_x', breachName: 'b', filterOn: false, gateOverride: false, batchSize: 1000, pipeline: true,
    }
    const worker = new Worker(bundle, { workerData: job })
    const message = await new Promise<WorkerMessage>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      setTimeout(() => reject(new Error('the bundle said nothing in 20 s')), 20_000)
    })
    await worker.terminate()
    expect(message.type).toBe('error')
    expect((message as Extract<WorkerMessage, { type: 'error' }>).message).toMatch(/ENOENT|no such file/i)
  }, 60_000)

  it('refuses a bundle that would carry SQLite, the job store or Next (checked on the bundle\'s inputs)', () => {
    const r = spawnSync('node', ['scripts/build-ingest-worker.mjs', '--out', join(out, 'unused.cjs'), '--entry', 'lib/upload-processor.ts'], { cwd: REPO, encoding: 'utf8' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/must not reach/)
  }, 60_000)
})
