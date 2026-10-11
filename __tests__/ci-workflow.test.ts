import { readFileSync } from 'fs'
import { describe, test, expect } from 'vitest'

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

describe('CI workflow', () => {
  test('pins the runner image: ubuntu-latest moves to Ubuntu 26 on 2026-10-19', () => {
    expect(ci).toContain('runs-on: ubuntu-24.04')
    expect(ci).not.toContain('ubuntu-latest')
  })

  test('uses action majors that run on Node 24 natively', () => {
    expect(ci).toContain('actions/checkout@v7')
    expect(ci).toContain('actions/setup-node@v7')
    expect(ci).not.toMatch(/actions\/(checkout|setup-node)@v[1-4]\b/)
  })
})

describe('CI workflow — build', () => {
  test('builds the app after lint: a build failure is caught here, not in the next Docker build', () => {
    expect(ci).toMatch(/- run: npm run build\n\s+env:\n\s+NEXT_TELEMETRY_DISABLED: '1'/)
    expect(ci.indexOf('npm run build')).toBeGreaterThan(ci.indexOf('npm run lint'))
  })
})

const dependabot = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')

describe('Dependabot', () => {
  test('npm weekly, minor and patch grouped into one pull request, at most 5 open', () => {
    expect(dependabot).toContain('package-ecosystem: npm')
    expect(dependabot).toContain('interval: weekly')
    expect(dependabot).toContain('open-pull-requests-limit: 5')
    expect(dependabot).toMatch(/minor-and-patch:\s+update-types:\s+- minor\s+- patch/)
  })

  test('major versions of the framework packages stay an owner decision', () => {
    const names = [
      'next', 'react', 'react-dom', 'tailwindcss', 'eslint', 'eslint-config-next', 'zod', 'typescript', 'vitest', 'better-sqlite3',
      '@types/node', '@types/react', '@types/react-dom', '@types/better-sqlite3',
    ]
    for (const name of names) {
      const escaped = name.replace(/[/@]/g, m => `\\${m}`)
      expect(dependabot, name).toMatch(new RegExp(`dependency-name: "${escaped}"\\s+update-types: \\["version-update:semver-major"\\]`))
    }
  })

  test('GitHub Actions are checked monthly', () => {
    expect(dependabot).toMatch(/package-ecosystem: github-actions[\s\S]*interval: monthly/)
  })
})
