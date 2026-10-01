import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO = resolve(__dirname, '..')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')

/** url, email, password, source_file, breach_name, imported_at — as `FORMAT TSV` prints them. */
const rows = [
  'https\t//shop.example.com/login\talice@mail.com|hunter22\tcombo.txt\t\t2026-07-24 05:14:13', // repairable
  'https\t//a.example.org/x\tbob|ab\tcombo.txt\t\t2026-07-24 05:14:14', // password too short
  'https\t//site.example.ru/login\tx@mail.ru|secret1\tcombo.txt\tSomeBreach\t2026-08-02 10:00:00', // T3: dropped by policy
  'https\t//a.example.org/x\tcarol|p%40ssw0rd\tother.txt\t\t2026-08-03 11:12:13', // percent-encoded password
  'https://a.example/x\ta@b.com\tpw1234\tother.txt\t\t2026-08-03 11:12:14', // not this shape at all
]

function run(args: string[], input: string, env: Record<string, string> = {}) {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^INGEST_FILTER_/.test(k)) base[k] = v
  return spawnSync(TSX, [join(REPO, 'scripts', 'repair-scheme-split-rows.ts'), ...args], {
    cwd: REPO, input, encoding: 'utf8', env: { ...base, ...env }, timeout: 60_000,
  })
}

describe('scripts/repair-scheme-split-rows.ts', () => {
  test('writes one JSON line per repaired row, with the original imported_at / source_file / breach_name', () => {
    const out = mkdtempSync(join(tmpdir(), 'repair-'))
    const file = join(out, 'repaired.jsonl')
    const r = run(['--out', file], rows.join('\n') + '\n', { INGEST_FILTER_HARD_DROP_TIERS: 'T3' })
    expect(r.status).toBe(0)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toEqual([
      { url: 'https://shop.example.com/login', email: 'alice@mail.com', password: 'hunter22', domain: 'shop.example.com', source_file: 'combo.txt', breach_name: '', imported_at: '2026-07-24 05:14:13' },
      { url: 'https://a.example.org/x', email: 'carol', password: 'p@ssw0rd', domain: 'a.example.org', source_file: 'other.txt', breach_name: '', imported_at: '2026-08-03 11:12:13' },
    ])
  }, 60_000)

  test('the report counts candidates, repairs and every reason for a row left alone, and ends with a verdict line', () => {
    const r = run(['--count-only'], rows.join('\n') + '\n', { INGEST_FILTER_HARD_DROP_TIERS: 'T3' })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/candidates:\s+5/)
    expect(r.stdout).toMatch(/repaired:\s+2/)
    expect(r.stdout).toMatch(/no_password\s+1/)
    expect(r.stdout).toMatch(/tier_dropped\s+1/)
    expect(r.stdout).toMatch(/not_scheme_split\s+1/)
    expect(r.stdout.trim().split('\n').pop()).toBe('repair-result: candidates=5 repaired=2 rejected=3')
  }, 60_000)

  test('--count-only writes no rows, and the report never contains a row', () => {
    const r = run(['--count-only'], rows.join('\n') + '\n', { INGEST_FILTER_HARD_DROP_TIERS: 'T3' })
    expect(r.stdout + r.stderr).not.toMatch(/alice|hunter22|shop\.example|secret1|carol/)
  }, 60_000)

  test('without the hard-drop policy the T3 row is repaired too', () => {
    const r = run(['--count-only'], rows.join('\n') + '\n', {})
    expect(r.stdout).toMatch(/repaired:\s+3/)
  }, 60_000)

  test('the whole ingest policy applies, not only the hard tiers: with DROP_NOISE a .php endpoint is left alone', () => {
    const input = 'https\t//shop.example.com/wp-login.php\talice@mail.com|hunter22\tcombo.txt\t\t2026-07-24 05:14:13\n'
    expect(run(['--count-only'], input, {}).stdout).toMatch(/repaired:\s+1/)
    const noisy = run(['--count-only'], input, { INGEST_FILTER_DROP_NOISE: 'true' })
    expect(noisy.stdout).toMatch(/repaired:\s+0/)
    expect(noisy.stdout).toMatch(/policy_dropped\s+1/)
  }, 60_000)

  test('a malformed line is an error (exit 2), never a silent skip', () => {
    const r = run(['--count-only'], 'https\t//h/p\n', {})
    expect(r.status).toBe(2)
  }, 60_000)
})
