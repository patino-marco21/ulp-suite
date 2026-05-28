import { describe, test, expect } from 'vitest'
import { checkLimit } from '@/lib/rate-limiter'

describe('checkLimit', () => {
  test('allows the first request', () => {
    const map = new Map()
    const result = checkLimit(map, 'ip-1', 3, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  test('blocks when limit is reached', () => {
    const map = new Map()
    checkLimit(map, 'ip-2', 2, 60_000)
    checkLimit(map, 'ip-2', 2, 60_000)
    const result = checkLimit(map, 'ip-2', 2, 60_000)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  test('resets after window expires', () => {
    const map = new Map()
    map.set('ip-3', { count: 99, resetAt: Date.now() - 1 })
    const result = checkLimit(map, 'ip-3', 3, 60_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  test('different keys are independent', () => {
    const map = new Map()
    checkLimit(map, 'a', 1, 60_000)
    checkLimit(map, 'a', 1, 60_000)
    const result = checkLimit(map, 'b', 1, 60_000)
    expect(result.allowed).toBe(true)
  })
})
