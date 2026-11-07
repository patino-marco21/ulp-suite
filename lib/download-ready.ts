/**
 * Is a download in the chat client's folder finished? (docs/superpowers/specs/2026-11-07-download-mover-design.md.) Telegram Desktop and AyuGram open the file under its final
 * name, hold it open for the whole download, write the parts at their offsets, delete it when the download is cancelled or fails, and close it when the last part is in
 * (Telegram/SourceFiles/storage/file_download.cpp: checkForOpen, writeResultPart, cancel, finalizeResult). So a file nobody has open is finished, and a file moved while the
 * client still holds it open would keep growing in its new place, which is what the importer then misses. Three checks, all of which must pass:
 *
 *   1. no process has the file open (a scan of /proc/<pid>/fd; the client runs in a sandbox, but its descriptors are readable here),
 *   2. the file has not been modified for a quiet period (a race guard: the client records the file right after it closes it),
 *   3. no part of the file was left unwritten: the client writes parts at their offsets, so an interrupted download (the client killed, a power cut; a normal quit deletes the
 *      partial file) can have holes, which show as fewer blocks on disk than bytes. A finished file has none.
 */
import { readdirSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs'
import { sep } from 'node:path'

/** Files under `dir` that some process holds open, with the pids. `excludePid` leaves out the caller (it holds a file open while it hashes it). Never throws. */
export function openFilesUnder(dir: string, opts: { procRoot?: string; excludePid?: number } = {}): Map<string, number[]> {
  const procRoot = opts.procRoot ?? '/proc'
  const prefixes = new Set<string>([dir + sep])
  try { prefixes.add(realpathSync(dir) + sep) } catch { /* the folder is gone: nothing is open in it */ }
  const open = new Map<string, number[]>()
  let pids: string[]
  try { pids = readdirSync(procRoot).filter(n => /^\d+$/.test(n)) } catch { return open }
  for (const pidText of pids) {
    const pid = Number(pidText)
    if (pid === opts.excludePid) continue
    let fds: string[]
    try { fds = readdirSync(`${procRoot}/${pidText}/fd`) } catch { continue }   // a process of another user, or one that just ended
    for (const fd of fds) {
      let target: string
      try { target = readlinkSync(`${procRoot}/${pidText}/fd/${fd}`) } catch { continue }
      if (target.endsWith(' (deleted)')) continue
      for (const prefix of prefixes) {
        if (!target.startsWith(prefix)) continue
        const pids = open.get(target) ?? []
        if (!pids.includes(pid)) pids.push(pid)
        open.set(target, pids)
        break
      }
    }
  }
  return open
}

export type PendingState = 'downloading' | 'settling' | 'interrupted'
export interface Readiness { ready: boolean; state?: PendingState; detail?: string }

const MiB = 1024 * 1024
/** A finished file has at least as many blocks as bytes (rounded up to the block size); this much slack covers the rounding. */
const HOLE_SLACK_BYTES = 4096n

/**
 * Whether the file at `path` (stat `st`, taken now) is finished. `open` is openFilesUnder() of its folder; `quietMs` is the quiet period. Not for a stand-in: the caller skips
 * those first (a stand-in is all hole by design).
 */
export function readiness(path: string, st: BigIntStats, o: { nowMs: number; quietMs: number; open: Map<string, number[]> }): Readiness {
  const pids = o.open.get(path)
  if (pids && pids.length > 0) return { ready: false, state: 'downloading', detail: `still open in another program (pid ${pids.join(', ')}): the download is not finished` }
  const idleMs = o.nowMs - Number(st.mtimeNs / 1_000_000n)
  if (idleMs < o.quietMs) {
    return { ready: false, state: 'settling', detail: `last changed ${Math.max(0, Math.round(idleMs / 1000))} s ago; it moves after ${Math.round(o.quietMs / 60_000 * 10) / 10} min without a change` }
  }
  if (st.blocks * 512n + HOLE_SLACK_BYTES < st.size) {
    const onDisk = Number(st.blocks * 512n) / MiB
    return { ready: false, state: 'interrupted', detail: `${onDisk.toFixed(1)} of ${(Number(st.size) / MiB).toFixed(1)} MiB are on disk: part of the file was never written, so the download looks interrupted (delete it and download again)` }
  }
  return { ready: true }
}
