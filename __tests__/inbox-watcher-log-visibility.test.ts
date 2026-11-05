import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

// The production build strips console.log (next.config.mjs removeConsole) and keeps error and warn, so a line that `docker logs` has to show must be a warn.
// The README tells the owner to follow an import with `docker compose logs -f app | grep inbox-watcher`: the three lines of a file's life must reach it.
describe('inbox watcher: the lifecycle of a file reaches docker logs in the production build', () => {
  const config = readFileSync(new URL('../next.config.mjs', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../lib/inbox-watcher.ts', import.meta.url), 'utf8')

  test('premise: the production build strips console.log and keeps error and warn', () => {
    const block = config.slice(config.indexOf('removeConsole'))
    expect(block).toMatch(/exclude:\s*\[\s*'error'\s*,\s*'warn'\s*\]/)
  })

  const methodOf = (marker: string): string[] =>
    [...source.matchAll(new RegExp('console\\.(\\w+)\\(\\s*`\\[inbox-watcher\\] ' + marker, 'g'))].map(m => m[1])

  test.each([
    ['queued: ', 1],
    ['processing: ', 1],
    ['done: ', 2],   // a plain or compressed text file, and a file read from the archive
  ])('"%s" is logged with console.warn at every site', (marker, sites) => {
    const methods = methodOf(marker)
    expect(methods).toHaveLength(sites)
    expect(methods.every(m => m === 'warn')).toBe(true)
  })

  test.each(['reconcile: queued', 'forceReconcile: queued', 'clearStaleInFlight: cleared'])('"%s" (a recovery or an operator action) is a warn too', marker => {
    const methods = methodOf(marker)
    expect(methods).toHaveLength(1)
    expect(methods[0]).toBe('warn')
  })
})
