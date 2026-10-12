import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const GATE_VARS = [
  'INGEST_QUALITY_GATE', 'INGEST_QUALITY_GATE_JUNK_PCT', 'INGEST_QUALITY_GATE_UNSPLIT_PCT', 'INGEST_QUALITY_GATE_GARBAGE_PCT',
  'INGEST_QUALITY_GATE_WARN_JUNK_PCT', 'INGEST_QUALITY_GATE_WARN_UNSPLIT_PCT', 'INGEST_QUALITY_GATE_MIN_LINES', 'INGEST_QUALITY_GATE_EARLY_LINES',
]

describe('quality gate and source archive wiring', () => {
  it('forwards every gate variable through the production compose file, empty by default (the defaults live in code)', () => {
    const compose = read('docker-compose.yml')
    for (const v of GATE_VARS) expect(compose, v).toContain(`${v}: \${${v}:-}`)
  })

  it('mounts the host archive directory read-only at /archive and points the app at it', () => {
    const compose = read('docker-compose.yml')
    expect(compose).toContain('ULP_ARCHIVE_DIR: /archive')
    expect(compose).toContain('- ${ULP_ARCHIVE_HOST_DIR:-${HOME}/ulp-archive}:/archive:ro')
  })

  it('tells the rehearsal app where the archive is; it has no host mount (the scenario copies a scratch archive in)', () => {
    const compose = read('docker-compose.rehearsal.yml')
    expect(compose).toContain('ULP_ARCHIVE_DIR: /archive')
    expect(compose).not.toMatch(/ulp-archive/)
  })

  it('documents the variables in .env.example and the README', () => {
    for (const file of ['.env.example', 'README.md']) {
      const text = read(file)
      for (const v of ['INGEST_QUALITY_GATE', 'INGEST_QUALITY_GATE_EARLY_LINES', 'ULP_ARCHIVE_HOST_DIR']) expect(text, `${file} ${v}`).toContain(v)
    }
  })
})
