import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('novelty-aware ingest wiring', () => {
  it('sweeps orphan stage tables before the inbox watcher starts importing', () => {
    const src = read('instrumentation.ts')
    const sweep = src.indexOf('startStageSweeper')
    const inbox = src.indexOf('startInboxWatcher()')
    expect(sweep).toBeGreaterThan(-1)
    expect(inbox).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(inbox)
    expect(src).toMatch(/Promise\.race\(\[\s*startStageSweeper\(\)/) // bounded: a slow ClickHouse must not delay the app
  })

  it('forwards both settings through the production compose file with empty defaults', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain('INGEST_NOVELTY_CHECK: ${INGEST_NOVELTY_CHECK:-}')
    expect(compose).toContain('INGEST_NOVELTY_SLAB_ROWS: ${INGEST_NOVELTY_SLAB_ROWS:-}')
  })

  it('lets the rehearsal compose file choose concurrency, the novelty check and the slab size', () => {
    const compose = read('docker-compose.rehearsal.yml')
    expect(compose).toContain('UPLOAD_CONCURRENCY: ${REHEARSAL_UPLOAD_CONCURRENCY:-}')
    expect(compose).toContain('INGEST_NOVELTY_CHECK: ${REHEARSAL_INGEST_NOVELTY_CHECK:-}')
    expect(compose).toContain('INGEST_NOVELTY_SLAB_ROWS: ${REHEARSAL_INGEST_NOVELTY_SLAB_ROWS:-}')
  })

  it('documents the settings in .env.example and the README', () => {
    expect(read('.env.example')).toContain('INGEST_NOVELTY_CHECK')
    expect(read('.env.example')).toContain('INGEST_NOVELTY_SLAB_ROWS')
    expect(read('README.md')).toContain('INGEST_NOVELTY_CHECK')
    expect(read('README.md')).toContain('INGEST_NOVELTY_SLAB_ROWS')
  })
})
