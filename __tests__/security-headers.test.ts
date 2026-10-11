import { describe, expect, test } from 'vitest'

async function load() {
  const mod = await import('../next.config.mjs')
  const config = mod.default as { poweredByHeader?: boolean; headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> }
  const rules = await config.headers()
  const headers = Object.fromEntries(rules[0].headers.map(h => [h.key, h.value]))
  return { config, headers }
}

describe('security headers', () => {
  test('the server does not announce its framework', async () => {
    expect((await load()).config.poweredByHeader).toBe(false)
  })

  test('the CSP has no eval and no CDN, and keeps the rest', async () => {
    const csp = (await load()).headers['Content-Security-Policy']
    const directive = (name: string) => csp.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `)) ?? ''
    expect(directive('script-src')).toBe("script-src 'self' 'unsafe-inline'")
    expect(directive('connect-src')).toBe("connect-src 'self'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('jsdelivr')
    expect(directive('default-src')).toBe("default-src 'self'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
  })

  test('the other headers are still sent', async () => {
    const { headers } = await load()
    for (const key of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security', 'Permissions-Policy']) {
      expect(headers[key], key).toBeTruthy()
    }
  })
})

describe('output tracing', () => {
  test('the data folders, the inbox included, are never copied into the standalone output', async () => {
    const mod = await import('../next.config.mjs')
    const excludes = (mod.default as unknown as { outputFileTracingExcludes: Record<string, string[]> }).outputFileTracingExcludes['*']
    for (const dir of ['./uploads/**', './clickhouse-data/**', './data/**', './inbox/**']) expect(excludes, dir).toContain(dir)
  })
})
