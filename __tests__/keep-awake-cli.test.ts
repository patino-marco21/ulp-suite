/**
 * scripts/keep-awake-while-busy.ts run for real in a sandbox: a fake inbox, and a fake `systemd-inhibit` on the PATH that logs what it is asked and what ends it.
 * Nothing here touches the real inbox or takes a real lock. Synthetic files only.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const SCRIPT = join(REPO, 'scripts', 'keep-awake-while-busy.ts')

let root = ''
let svc: ChildProcess | undefined
// `tsx` is a wrapper that starts node as its child, and killing only the wrapper leaves that child (and the fake systemd-inhibit under it) running for good.
// The service is started as the leader of its own process group, so one kill on the group ends all three.
afterEach(() => {
  if (svc?.pid) { try { process.kill(-svc.pid, 'SIGKILL') } catch { /* the group is already gone */ } }
  svc = undefined; if (root) rmSync(root, { recursive: true, force: true }); root = ''
})

/** A fake systemd-inhibit: logs its arguments, then holds until it is terminated (and logs that). SHIM_REFUSE makes it fail at once when asked to block the lid switch. */
function start(env: NodeJS.Dict<string> = {}) {
  root = mkdtempSync(join(tmpdir(), 'keep-awake-'))
  const inbox = join(root, 'repo', 'inbox'), bin = join(root, 'bin'), power = join(root, 'power'), log = join(root, 'inhibit.log')
  for (const d of [join(inbox, 'processing'), join(inbox, 'done'), bin, power]) mkdirSync(d, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(join(bin, 'systemd-inhibit'), `#!/bin/bash
echo "inhibit $*" >> "${log}"
if [ -n "$SHIM_REFUSE" ] && [[ "$*" == *handle-lid-switch* ]]; then echo "Failed to inhibit" >&2; exit 1; fi
trap 'echo released >> "${log}"; exit 0' TERM
sleep 600 &
wait
`, { mode: 0o755 })
  const logOut: string[] = []
  svc = spawn(TSX, [SCRIPT], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ULP_REPO: join(root, 'repo'), ULP_KEEP_AWAKE_TICK_MS: '150', ULP_KEEP_AWAKE_GRACE_MS: '700', ULP_KEEP_AWAKE_BATTERY_DIR: power, ...env },
  })
  svc.stdout?.on('data', d => logOut.push(String(d)))
  svc.stderr?.on('data', d => logOut.push(String(d)))
  return { inbox, power, inhibitLog: () => readFileSync(log, 'utf8'), serviceLog: () => logOut.join('') }
}
const waitUntil = (fn: () => boolean, ms = 15_000) => vi.waitFor(() => { if (!fn()) throw new Error('not yet') }, { timeout: ms, interval: 100 })

describe('keep-awake-while-busy', () => {
  test('takes a sleep and lid-switch inhibitor when a file waits in the inbox, and releases it a moment after the inbox is empty', async () => {
    const s = start()
    await waitUntil(() => s.serviceLog().includes('watching'))
    expect(s.inhibitLog()).toBe('')                                                  // an idle inbox holds nothing
    writeFileSync(join(s.inbox, 'waiting.txt'), 'x')
    await waitUntil(() => s.inhibitLog().includes('inhibit '))
    expect(s.inhibitLog()).toMatch(/inhibit --what=sleep:handle-lid-switch --who=ulp-suite --why=.* --mode=block sleep infinity/)
    expect(s.inhibitLog().match(/inhibit /g)).toHaveLength(1)                        // taken once, not at every check
    rmSync(join(s.inbox, 'waiting.txt'))
    await waitUntil(() => s.inhibitLog().includes('released'))
    expect(s.serviceLog()).toMatch(/released the sleep inhibitor: the inbox has been idle/)
  })

  test('a file in processing/ holds the lock too, and a short gap between two files does not release it', async () => {
    const s = start()
    writeFileSync(join(s.inbox, 'processing', 'p.txt'), 'x')
    await waitUntil(() => s.inhibitLog().includes('inhibit '))
    rmSync(join(s.inbox, 'processing', 'p.txt'))
    await new Promise(r => setTimeout(r, 300))                                       // under the 700 ms grace
    writeFileSync(join(s.inbox, 'processing', 'q.txt'), 'x')
    await new Promise(r => setTimeout(r, 1_200))
    expect(s.inhibitLog()).not.toContain('released')
    expect(s.inhibitLog().match(/inhibit /g)).toHaveLength(1)
  })

  test('falls back to sleep only when the system refuses to block the lid switch, and says so', async () => {
    const s = start({ SHIM_REFUSE: '1' })
    writeFileSync(join(s.inbox, 'waiting.txt'), 'x')
    await waitUntil(() => /inhibit --what=sleep --who/.test(s.inhibitLog()))
    expect(s.inhibitLog()).toMatch(/inhibit --what=sleep:handle-lid-switch/)
    expect(s.serviceLog()).toMatch(/refused to block the lid switch for a user service; holding "sleep" only/)
  })

  test('does not hold the lock on a low battery', async () => {
    const s = start()
    mkdirSync(join(s.power, 'BAT0'), { recursive: true })
    writeFileSync(join(s.power, 'BAT0', 'type'), 'Battery\n'); writeFileSync(join(s.power, 'BAT0', 'status'), 'Discharging\n'); writeFileSync(join(s.power, 'BAT0', 'capacity'), '9\n')
    writeFileSync(join(s.inbox, 'waiting.txt'), 'x')
    await new Promise(r => setTimeout(r, 1_000))
    expect(s.inhibitLog()).toBe('')
    writeFileSync(join(s.power, 'BAT0', 'status'), 'Charging\n')
    await waitUntil(() => s.inhibitLog().includes('inhibit '))
  })

  test('releases the lock when the service is stopped', async () => {
    const s = start()
    writeFileSync(join(s.inbox, 'waiting.txt'), 'x')
    await waitUntil(() => s.inhibitLog().includes('inhibit '))
    svc?.kill('SIGTERM')
    await waitUntil(() => s.inhibitLog().includes('released'))
  })
})
