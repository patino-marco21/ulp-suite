/**
 * The archive CLI run for real in a sandbox: fake sources, an archive directory, a fake repository with an inbox, and a fake `docker` that answers the ulp.sources
 * listing from a file and logs what it is given. Nothing here touches the real inbox, pile, archive or ClickHouse. Synthetic files only.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'archive-sources.ts')

interface Box { root: string; src: string; arc: string; inbox: string; sources: string; dockerLog: string; env: NodeJS.ProcessEnv }
let box: Box | undefined
afterEach(() => { if (box) rmSync(box.root, { recursive: true, force: true }); box = undefined })

/** Sources of the given names and bodies, aged `ageMs`; an empty archive directory; an empty inbox; a docker that logs. */
function makeBox(files: Record<string, string>, ageMs = 60 * 60_000): Box {
  const root = mkdtempSync(join(tmpdir(), 'archive-cli-'))
  const src = join(root, 'src'), arc = join(root, 'arc'), repo = join(root, 'repo'), bin = join(root, 'bin')
  const inbox = join(repo, 'inbox')
  for (const d of [src, arc, join(inbox, 'done'), join(inbox, 'failed'), join(inbox, 'processing'), bin]) mkdirSync(d, { recursive: true })
  const when = new Date(Date.now() - ageMs)
  for (const [name, body] of Object.entries(files)) { const p = join(src, name); writeFileSync(p, body); utimesSync(p, when, when) }
  const sources = join(root, 'sources.jsonl'), dockerLog = join(root, 'docker.log')
  writeFileSync(sources, ''); writeFileSync(dockerLog, '')
  // docker exec [-i] <container> clickhouse-client [-n] [-q <sql>]: the listing comes from a file; a script on stdin (the last argument is -n) is logged
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ -n "$SHIM_FAIL" ]; then echo "Code: 210. DB::Exception: connection refused" >&2; exit 1; fi
sql="\${@: -1}"
case "$sql" in
  "SELECT filename FROM ulp.sources FORMAT JSONEachRow") cat "${sources}" ;;
  -n) cat >> "${dockerLog}" ;;
  *) echo "$sql" >> "${dockerLog}" ;;
esac
`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ULP_ARCHIVE_DIR: arc, ULP_REPO: repo, CH_CONTAINER: 'fake-clickhouse',
    ULP_ARCHIVE_FREE_MARGIN_BYTES: '0',    // a CI runner may have under 10 GiB free; the margin has its own unit test
  }
  return { root, src, arc, inbox, sources, dockerLog, env }
}

const run = (b: Box, args: string[], extra: NodeJS.Dict<string> = {}) =>
  spawnSync(TSX, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env: { ...b.env, ...extra }, timeout: 120_000 })
const manifest = (b: Box) => readFileSync(join(b.arc, 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

describe('archive, status, verify, restore', () => {
  test('round-trips files and never overwrites a restore target', () => {
    box = makeBox({ 'a.txt': 'line one\nline two\n', 'b.txt': 'other\n' })
    const a = run(box, ['archive', '--src', box.src, '--workers', '2', '--no-sources'])
    expect(a.status).toBe(0)
    expect(a.stdout).toMatch(/archived 2, already archived 0, too young 0, replaced 0, kept 0, failed 0/)
    expect(readdirSync(box.arc).filter(n => n.endsWith('.zst'))).toHaveLength(2)
    expect(manifest(box)).toHaveLength(2)

    const st = run(box, ['status'])
    expect(st.status).toBe(0)
    expect(st.stdout).toMatch(/names 2 \(0 replaced\), archives 2/)

    const v = run(box, ['verify', '--all'])
    expect(v.status).toBe(0)
    expect(v.stdout).not.toMatch(/FAIL/)

    const to = join(box.root, 'restored.txt')
    const r = run(box, ['restore', 'a.txt', '--to', to])
    expect(r.status).toBe(0)
    expect(readFileSync(to, 'utf8')).toBe('line one\nline two\n')
    const again = run(box, ['restore', 'a.txt', '--to', to])
    expect(again.status).toBe(2)
    expect(again.stderr).toMatch(/refusing to overwrite/)
  })

  test('a second run archives nothing again', () => {
    box = makeBox({ 'a.txt': 'x\n', 'b.txt': 'y\n' })
    expect(run(box, ['archive', '--src', box.src, '--no-sources']).status).toBe(0)
    const second = run(box, ['archive', '--src', box.src, '--no-sources'])
    expect(second.stdout).toMatch(/archived 0, already archived 2/)
    expect(manifest(box)).toHaveLength(2)
  })

  test('a file modified a minute ago is skipped', () => {
    box = makeBox({ 'young.txt': 'x\n' }, 60_000)
    const r = run(box, ['archive', '--src', box.src, '--no-sources'])
    expect(r.stdout).toMatch(/archived 0, already archived 0, too young 1/)
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('--dry-run writes nothing', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const r = run(box, ['archive', '--src', box.src, '--dry-run'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/dry run/)
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('a missing archive directory is refused and not created', () => {
    box = makeBox({ 'a.txt': 'x\n' })
    const nope = join(box.root, 'nope')
    const r = run(box, ['archive', '--src', box.src, '--no-sources'], { ULP_ARCHIVE_DIR: nope })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/does not exist/)
    expect(existsSync(nope)).toBe(false)
  })

  test('verify fails (exit 1) on a damaged archive', () => {
    box = makeBox({ 'a.txt': 'some bytes that will be damaged\n'.repeat(20) })
    run(box, ['archive', '--src', box.src, '--no-sources'])
    const z = readdirSync(box.arc).find(n => n.endsWith('.zst')) as string
    const bytes = readFileSync(join(box.arc, z)); bytes[Math.floor(bytes.length / 2)] ^= 0xff
    writeFileSync(join(box.arc, z), bytes)
    const v = run(box, ['verify', '--all'])
    expect(v.status).toBe(1)
    expect(v.stdout).toMatch(/FAIL/)
  })
})

describe('--replace', () => {
  const body = 'secret one\nsecret two\n'

  test('removes the original and its inbox/done hardlink, nothing else, records replaced_at, and the archive restores the bytes', () => {
    box = makeBox({ 'r.txt': body })
    linkSync(join(box.src, 'r.txt'), join(box.inbox, 'done', 'r.txt'))
    writeFileSync(join(box.inbox, 'done', 'copy.txt'), body)
    writeFileSync(box.sources, JSON.stringify({ filename: 'r.txt' }) + '\n')
    const r = run(box, ['archive', '--src', box.src, '--replace', '--workers', '1'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/replaced 1, kept 0, failed 0/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(false)
    expect(existsSync(join(box.inbox, 'done', 'r.txt'))).toBe(false)
    expect(readFileSync(join(box.inbox, 'done', 'copy.txt'), 'utf8')).toBe(body)
    const lines = manifest(box)
    expect(lines).toHaveLength(2)
    expect(lines[1].replaced_at).toBeTruthy()
    expect(readFileSync(box.dockerLog, 'utf8')).toMatch(/ALTER TABLE ulp\.sources UPDATE size = transform\(filename, \['r\.txt'\]/)
    const to = join(box.root, 'back.txt')
    expect(run(box, ['restore', 'r.txt', '--to', to]).status).toBe(0)
    expect(readFileSync(to, 'utf8')).toBe(body)
  })

  test('keeps the original while a file is in flight in the inbox', () => {
    box = makeBox({ 'r.txt': body })
    writeFileSync(box.sources, JSON.stringify({ filename: 'r.txt' }) + '\n')
    writeFileSync(join(box.inbox, 'pending.txt'), 'x')
    const r = run(box, ['archive', '--src', box.src, '--replace', '--no-sources'])
    expect(r.stdout).toMatch(/kept r\.txt: a file is in flight/)
    expect(r.stdout).toMatch(/replaced 0, kept 1/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
  })

  test('keeps a name that is not in ulp.sources unless --include-unimported', () => {
    box = makeBox({ 'r.txt': body })
    const kept = run(box, ['archive', '--src', box.src, '--replace', '--no-sources'])
    expect(kept.stdout).toMatch(/kept r\.txt: not in ulp\.sources/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
    const forced = run(box, ['archive', '--src', box.src, '--replace', '--include-unimported', '--no-sources'])
    expect(forced.stdout).toMatch(/replaced 1/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(false)
  })

  test('without ClickHouse it refuses before touching anything', () => {
    box = makeBox({ 'r.txt': body })
    const r = run(box, ['archive', '--src', box.src, '--replace'], { SHIM_FAIL: '1' })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--replace needs ulp\.sources/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
    expect(readdirSync(box.arc)).toEqual([])
  })

  test('an original that changed after an earlier archive run is not removed', () => {
    box = makeBox({ 'r.txt': body })
    writeFileSync(box.sources, JSON.stringify({ filename: 'r.txt' }) + '\n')
    expect(run(box, ['archive', '--src', box.src, '--no-sources']).status).toBe(0)
    const when = new Date(Date.now() - 3_600_000)
    writeFileSync(join(box.src, 'r.txt'), body.replace('one', 'ONE'))        // same size, different bytes
    utimesSync(join(box.src, 'r.txt'), when, when)
    const r = run(box, ['archive', '--src', box.src, '--replace', '--no-sources'])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/FAILED r\.txt: .*no longer matches its archive/)
    expect(existsSync(join(box.src, 'r.txt'))).toBe(true)
  })
})

describe('sources-sync', () => {
  test('sends the identity statements for the archived names', () => {
    box = makeBox({ 's.txt': 'abc\n' })
    run(box, ['archive', '--src', box.src, '--no-sources'])
    const r = run(box, ['sources-sync'])
    expect(r.status).toBe(0)
    const log = readFileSync(box.dockerLog, 'utf8')
    expect(log).toMatch(/ADD COLUMN IF NOT EXISTS archive_id String DEFAULT ''/)
    expect(log).toMatch(/UPDATE size = transform\(filename, \['s\.txt'\], \[4\]/)
  })
})
