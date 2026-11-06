import { join } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const REPO = new URL('../', import.meta.url).pathname

/**
 * lib/ingest-stream.ts is what a parse worker runs (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step C). A worker is a bare Node thread: it has no Next, no
 * job store, no SQLite handle of the app. This bundles the module the way scripts/build-ingest-worker.mjs does and fails when one of those is reachable from it, so the
 * boundary cannot drift silently.
 */
async function inputsOf(entry: string): Promise<{ files: string[]; externals: string[] }> {
  const result = await build({
    entryPoints: [join(REPO, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    packages: 'external',
    tsconfig: join(REPO, 'tsconfig.json'),
    logLevel: 'silent',
  })
  const files = Object.keys(result.metafile.inputs)
  const externals = new Set<string>()
  for (const input of Object.values(result.metafile.inputs)) for (const i of input.imports) if (i.external) externals.add(i.path)
  return { files, externals: [...externals] }
}

const FORBIDDEN_FILES = [
  'lib/sqlite.ts', 'lib/upload-jobs.ts', 'lib/processing-log.ts', 'lib/domain-monitor.ts', 'lib/ingest-metrics.ts', 'lib/upload-processor.ts', 'lib/inbox-watcher.ts',
]
const FORBIDDEN_PACKAGES = ['better-sqlite3', 'yauzl', 'next']

describe('lib/ingest-stream.ts and lib/ingest-worker.ts (the code a parse worker runs)', () => {
  for (const entry of ['lib/ingest-stream.ts', 'lib/ingest-worker.ts']) {
    it(`${entry} reaches no SQLite, no job store and no Next`, async () => {
      const { files, externals } = await inputsOf(entry)
      for (const f of FORBIDDEN_FILES) expect(files, `${f} must not be reachable from ${entry}`).not.toContain(f)
      for (const p of FORBIDDEN_PACKAGES) {
        expect(externals.filter(e => e === p || e.startsWith(`${p}/`)), `${p} must not be imported from ${entry}`).toEqual([])
      }
    })
  }

  it('holds the staging loop and the batch insert', async () => {
    const mod = await import('@/lib/ingest-stream')
    expect(typeof mod.streamCredentialsToTable).toBe('function')
    expect(typeof mod.insertBatch).toBe('function')
    expect(mod.UPLOAD_BATCH_SIZE).toBe(100_000)
  })

  it('is still exported by lib/upload-processor.ts, so no caller changes', async () => {
    const processor = await import('@/lib/upload-processor')
    const stream = await import('@/lib/ingest-stream')
    expect(processor.insertBatch).toBe(stream.insertBatch)
    expect(processor.UPLOAD_BATCH_SIZE).toBe(stream.UPLOAD_BATCH_SIZE)
    expect(typeof processor.streamCredentialsToTable).toBe('function')
  })
})
