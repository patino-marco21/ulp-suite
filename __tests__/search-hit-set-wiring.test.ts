import { readFileSync } from 'node:fs'
import { describe, test, expect } from 'vitest'
import { HIT_SET_DEFAULT_MAX_HITS, HIT_SET_CEILING_MAX_HITS } from '@/lib/search-hit-set'

const read = (path: string) => readFileSync(path, 'utf8')
const VARS = ['SEARCH_HIT_SET', 'SEARCH_HIT_SET_MAX_HITS']

describe('hit-set plan wiring', () => {
  test.each(VARS)('docker-compose forwards %s to the app (compose passes no other .env keys)', name => {
    expect(read('docker-compose.yml')).toContain(`${name}: \${${name}:-}`)
  })

  test.each(VARS)('.env.example documents %s', name => {
    expect(read('.env.example')).toContain(`# ${name}=`)
  })

  test('the README explains the plan, its switches and its limits, with the numbers the code uses', () => {
    const readme = read('README.md')
    expect(readme).toContain('### One scan per substring search')
    expect(readme).toContain('SEARCH_HIT_SET=0')
    expect(readme).toContain('hit_set=0')
    expect(readme).toContain('SEARCH_HIT_SET_MAX_HITS')
    expect(readme).toContain(`at most ${HIT_SET_DEFAULT_MAX_HITS.toLocaleString('en-US')} of them`)
    expect(readme).toContain(`at most ${HIT_SET_CEILING_MAX_HITS.toLocaleString('en-US')}`)
    expect(readme).toContain('2026-10-26-slow-search-latency-design.md')
  })

  test('the README says that abandoned searches are cancelled, and why a closed connection is not enough', () => {
    const readme = read('README.md')
    expect(readme).toContain('### Abandoned searches are cancelled')
    expect(readme).toContain('KILL QUERY')
    expect(readme).toContain('http_wait_end_of_query=1')
  })

  test('the design document exists and carries its status in the first lines', () => {
    const spec = read('docs/superpowers/specs/2026-10-26-slow-search-latency-design.md')
    expect(spec.split('\n').slice(0, 6).join('\n')).toMatch(/Status:/)
  })
})
