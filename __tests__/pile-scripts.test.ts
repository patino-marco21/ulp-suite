/** The pile operations scripts: syntax, the guards that protect the originals, and the parameters. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const path = (f: string) => new URL(`../scripts/pile/${f}`, import.meta.url).pathname
const read = (f: string) => readFileSync(path(f), 'utf8')

describe('scripts/pile', () => {
  test.each(['feed.sh', 'reset.sh', 'watch.sh', 'global-checks.sh'])('%s is valid bash', f => {
    execFileSync('bash', ['-n', path(f)])
  })
  test('nothing is hard-wired to one machine or one session', () => {
    for (const f of ['feed.sh', 'reset.sh', 'watch.sh', 'global-checks.sh', 'jobs-summary.cjs', 'verify-file.ts', 'archive-queue.cjs']) {
      const s = read(f)
      expect(s, f).not.toContain('/tmp/claude-')
      expect(s, f).not.toContain('/home/cole')
    }
  })
  test('the feeder never deletes, moves or edits an original: it hardlinks only', () => {
    const s = read('feed.sh')
    expect(s).toContain('ln "$PILE_DIR/$name" "inbox/$name"')
    expect(s).not.toMatch(/\b(rm|mv|cp|truncate|touch|chmod|sed -i)\b[^\n]*PILE_DIR/)
  })
  test('the reset removes only inbox/done names that are hardlinks of pile originals (inode and link-count guard) and aborts when files are in flight', () => {
    const s = read('reset.sh')
    expect(s).toContain('stat -c %i')
    expect(s).toContain('stat -c %h')
    expect(s).toContain('ABORT: files are in flight')
    expect(s).not.toContain('"$PILE_DIR"/*')     // never a glob over the originals
  })
  test('the feeder stops on a failed file and on low disk, and has a dry run', () => {
    const s = read('feed.sh')
    expect(s).toContain('STOP new file(s) in inbox/failed')
    expect(s).toContain('LOW DISK')
    expect(s).toContain('DRY_RUN')
  })
  test('the scripts work on the checkout named by ULP_REPO (default: their own) and call their sibling scripts by their own path', () => {
    for (const f of ['feed.sh', 'reset.sh', 'watch.sh']) {
      const s = read(f)
      expect(s, f).toContain('REPO=${ULP_REPO:-')
      expect(s, f).not.toContain('node scripts/pile/')
    }
  })
  test('feed.sh, watch.sh and reset.sh do not count the held directory as a file in flight', () => {
    for (const f of ['feed.sh', 'watch.sh', 'reset.sh']) expect(read(f), f).toContain('(done|failed|processing|held)')
  })
  test('the feeder knows the archive source, the preflight and the held files, and the archive helper is plain CommonJS', () => {
    const s = read('feed.sh')
    for (const word of ['SOURCE', 'PREFLIGHT_CMD', 'archive-queue.cjs', 'HELD +', 'SKIP']) expect(s, word).toContain(word)
    expect(read('archive-queue.cjs')).not.toMatch(/^import |\brequire\('@\//m)
  })
})
