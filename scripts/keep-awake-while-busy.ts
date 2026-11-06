/**
 * Keeps the laptop awake while the inbox has work (ticket 06 of .scratch/ingest-yield-and-throughput). A suspended laptop freezes the connection to ClickHouse and an
 * import stalls (the stall watchdog then fails the file; ticket 03 retries it once); this takes a systemd sleep inhibitor while files wait or are processed and
 * releases it a few minutes after both are done.
 *
 *   tsx scripts/keep-awake-while-busy.ts
 *
 * Run by a systemd user service (scripts/systemd/ulp-keep-awake.service, installed by the owner); it needs no sudo. WHAT CHANGES: while the inbox is busy the laptop does not
 * suspend, and with `handle-lid-switch` held neither does shutting the lid, so a laptop in a bag keeps running and warm. Safeguards: the lock is never held for more than
 * 12 hours at a stretch, and is not held on battery power under 15%. If a user service may not block the lid switch on this system, it falls back to `sleep` only and says so.
 *
 * Environment: ULP_REPO (the checkout whose ./inbox is watched; default the current directory), ULP_KEEP_AWAKE_TICK_MS (check interval, default 30000),
 * ULP_KEEP_AWAKE_GRACE_MS (idle time before release, default 5 minutes), ULP_KEEP_AWAKE_BATTERY_DIR (default /sys/class/power_supply, for tests).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { inboxIsBusy } from '@/lib/archive-replace'
import { GRACE_MS, MAX_HOLD_MS, batteryIsLow, keepAwakeAction, type BatteryReading } from '@/lib/keep-awake'

const INBOX = join(process.env.ULP_REPO ?? process.cwd(), 'inbox')
const TICK_MS = Number(process.env.ULP_KEEP_AWAKE_TICK_MS ?? 30_000)
const GRACE = Number(process.env.ULP_KEEP_AWAKE_GRACE_MS ?? GRACE_MS)
const POWER_DIR = process.env.ULP_KEEP_AWAKE_BATTERY_DIR ?? '/sys/class/power_supply'
const WHY = 'ULP inbox: files are waiting or being imported'

function say(message: string): void { console.log(`[keep-awake] ${message}`) }

/** The first battery found in the power-supply directory, or null (a desktop, an unreadable directory). */
function readBattery(): BatteryReading | null {
  try {
    for (const name of readdirSync(POWER_DIR)) {
      try {
        if (readFileSync(join(POWER_DIR, name, 'type'), 'utf8').trim() !== 'Battery') continue
        return {
          status: readFileSync(join(POWER_DIR, name, 'status'), 'utf8').trim(),
          capacity: Number(readFileSync(join(POWER_DIR, name, 'capacity'), 'utf8').trim()),
        }
      } catch { /* not a battery, or a reading that is not there */ }
    }
  } catch { /* no power-supply directory */ }
  return null
}

let holder: ChildProcess | null = null
let holdingSinceMs: number | null = null
let lastBusyMs: number | null = null
let capped = false
/** What the lock blocks. handle-lid-switch is dropped for good if the system refuses it to a user service. */
let what = 'sleep:handle-lid-switch'

function take(): void {
  const blocks = what
  const child = spawn('systemd-inhibit', [`--what=${blocks}`, '--who=ulp-suite', `--why=${WHY}`, '--mode=block', 'sleep', 'infinity'], { stdio: 'ignore' })
  const startedAt = Date.now()
  child.on('error', err => { say(`could not start systemd-inhibit: ${err.message}`); if (holder === child) { holder = null; holdingSinceMs = null } })
  child.on('exit', code => {
    if (holder !== child) return   // released on purpose
    holder = null
    holdingSinceMs = null
    if (code !== 0 && Date.now() - startedAt < 5_000 && blocks.includes('handle-lid-switch')) {
      what = 'sleep'
      say('the system refused to block the lid switch for a user service; holding "sleep" only (shutting the lid will still suspend)')
    } else {
      say(`the inhibitor process ended (exit ${code}); it is taken again at the next check if the inbox is still busy`)
    }
  })
  holder = child
  holdingSinceMs = startedAt
  say(`holding a sleep inhibitor (${blocks}): ${WHY}`)
}

function release(reason: string): void {
  if (!holder) return
  const child = holder
  holder = null
  holdingSinceMs = null
  child.kill('SIGTERM')
  say(`released the sleep inhibitor: ${reason}`)
}

function tick(): void {
  const busy = inboxIsBusy(INBOX)
  const now = Date.now()
  if (busy) lastBusyMs = now
  const decision = keepAwakeAction({
    busy, holding: holder !== null, holdingSinceMs, lastBusyMs, nowMs: now, graceMs: GRACE, maxHoldMs: MAX_HOLD_MS, batteryLow: batteryIsLow(readBattery()), capped,
  })
  capped = decision.capped
  if (decision.action === 'take') take()
  else if (decision.action === 'release') release(decision.reason)
}

function stop(): void {
  release('the service is stopping')
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

say(`watching ${INBOX} every ${Math.round(TICK_MS / 1000)} s`)
tick()
setInterval(tick, TICK_MS)
