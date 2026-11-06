#!/usr/bin/env node
/**
 * Bundles the parse worker (lib/ingest-worker.ts) into one CommonJS file the importer starts as a worker thread
 * (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step C).
 *
 *   node scripts/build-ingest-worker.mjs [--out dist/ingest-worker.cjs] [--entry lib/ingest-worker.ts]
 *
 * Run by `npm run build` (so the Docker build and CI run it) after `next build`. The runner image carries only what Next traced, so the worker bundles its own
 * dependencies. A worker is a bare thread: it must not reach Next, SQLite, the job store or the zip reader, and that is checked on the bundle's inputs before
 * anything is written, so the boundary cannot drift silently (__tests__/ingest-stream-boundary.test.ts checks the same lists from the test side).
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const entry = valueOf('entry', 'lib/ingest-worker.ts')
const out = resolve(valueOf('out', 'dist/ingest-worker.cjs'))

const FORBIDDEN_FILES = [
  'lib/sqlite.ts', 'lib/upload-jobs.ts', 'lib/processing-log.ts', 'lib/domain-monitor.ts', 'lib/ingest-metrics.ts', 'lib/upload-processor.ts', 'lib/inbox-watcher.ts',
]
const FORBIDDEN_PACKAGES = ['better-sqlite3', 'yauzl', 'next']
const common = { entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', tsconfig: 'tsconfig.json', logLevel: 'silent' }

try {
  // First look: which files and packages does the entry reach? Packages stay external here, so a native addon cannot get in the way of the look.
  const probe = await build({ ...common, write: false, metafile: true, packages: 'external' })
  const files = Object.keys(probe.metafile.inputs)
  const packages = new Set()
  for (const input of Object.values(probe.metafile.inputs)) for (const i of input.imports) if (i.external) packages.add(i.path)
  const reached = [
    ...FORBIDDEN_FILES.filter(f => files.includes(f)),
    ...FORBIDDEN_PACKAGES.filter(p => [...packages].some(e => e === p || e.startsWith(`${p}/`))),
  ]
  if (reached.length > 0) {
    console.error(`the parse worker bundle must not reach ${reached.join(', ')} (entry ${entry})`)
    process.exit(1)
  }

  mkdirSync(dirname(out), { recursive: true })
  await build({ ...common, outfile: out, target: 'node24', legalComments: 'none' })
  console.log(`built ${out} (${Math.round(statSync(out).size / 1024)} KiB, ${files.length} source files)`)
} catch (err) {
  console.error(`could not build the parse worker: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
