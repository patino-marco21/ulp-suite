import { describe, it, expect } from 'vitest'
import path from 'path'
import { getWorkerDbPath } from './worker-db-path'

describe('getWorkerDbPath', () => {
  it('includes the pool id in the filename', () => {
    const p = getWorkerDbPath('3', '/tmp')
    expect(p).toBe(path.join('/tmp', 'ulp-suite-vitest-worker-3.db'))
  })

  it('produces different paths for different pool ids', () => {
    const a = getWorkerDbPath('1', '/tmp')
    const b = getWorkerDbPath('2', '/tmp')
    expect(a).not.toBe(b)
  })

  it('falls back to a fixed id when poolId is undefined', () => {
    const p = getWorkerDbPath(undefined, '/tmp')
    expect(p).toBe(path.join('/tmp', 'ulp-suite-vitest-worker-0.db'))
  })
})
