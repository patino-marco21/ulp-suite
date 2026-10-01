import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

/**
 * docker-compose.rehearsal.yml starts a ClickHouse, an app and a webhook receiver for scripts/e2e-alert-rehearsal.ts. It runs
 * on the same Docker daemon as the real stack, so the one thing it must never do is touch it: no shared name, network,
 * volume, port or host directory.
 */
const compose = readFileSync('docker-compose.rehearsal.yml', 'utf8')
const prod = readFileSync('docker-compose.yml', 'utf8')
const lines = compose.split('\n').filter(l => !l.trim().startsWith('#'))
const body = lines.join('\n')

describe('docker-compose.rehearsal.yml shares nothing with the production stack', () => {
  test('its own project and network', () => {
    expect(body).toMatch(/^name: ulp-rehearsal$/m)
    expect(body).toContain('name: ulprehearsal_network')
  })

  test('every container is named ulprehearsal_*, and none of the production names appear', () => {
    const names = [...body.matchAll(/container_name:\s*(\S+)/g)].map(m => m[1])
    expect(names.length).toBe(3)
    for (const n of names) expect(n).toMatch(/^ulprehearsal_/)
    expect(body).not.toContain('ulpsuite_')
    for (const n of [...prod.matchAll(/container_name:\s*(\S+)/g)].map(m => m[1])) expect(body).not.toContain(n)
  })

  test('no host directory of the real stack is mounted: no ./data, ./inbox, ./uploads, ./.env or the Docker socket', () => {
    for (const bad of ['./data', './inbox', './uploads', './.env', 'docker.sock', 'clickhouse_data']) expect(body, bad).not.toContain(bad)
  })

  test('the only host directories mounted are the production config and init files, read-only, plus the receiver script', () => {
    const binds = [...body.matchAll(/^\s+- (\.\/[^:\s]+):([^:\s]+)(?::(\w+))?$/gm)].map(m => ({ host: m[1], mode: m[3] }))
    expect(binds.map(b => b.host).sort()).toEqual(
      ['./docker/clickhouse/config', './docker/clickhouse/init', './docker/clickhouse/users', './docker/rehearsal/receiver.js'].sort(),
    )
    for (const b of binds) expect(b.mode, b.host).toBe('ro')
  })

  test('data lives in named volumes that are not production\'s', () => {
    const volumes = body.slice(body.lastIndexOf('\nvolumes:'))
    const names = [...volumes.matchAll(/^\s{2}(\w+):\s*$/gm)].map(m => m[1])
    expect(names.length).toBeGreaterThanOrEqual(4)
    for (const n of names) expect(n).toMatch(/^rehearsal_/)
  })

  test('the only published port is the app, on loopback, on a port production does not use', () => {
    const ports = [...body.matchAll(/^\s+- "([^"]+:\d+:\d+)"$/gm)].map(m => m[1])
    expect(ports).toEqual(['127.0.0.1:3101:3000'])
    expect(prod).not.toContain('3101')
  })

  test('it does not build anything: it uses the image `docker compose build app` produced', () => {
    expect(body).not.toMatch(/^\s+build:/m)
    expect(body).toContain('image: ulp-suite-app:latest')
  })

  test('the secrets are required from the driver, never written in the file', () => {
    expect(body).toContain('REHEARSAL_JWT_SECRET:?')
    expect(body).toContain('REHEARSAL_ADMIN_PASSWORD:?')
    expect(body).toContain('REHEARSAL_WEBHOOK_SECRET:?')
  })
})
