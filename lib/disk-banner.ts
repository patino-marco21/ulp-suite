/**
 * What the disk banner under the header says. Pure on purpose: the client component imports this file, so it may only
 * `import type` from server modules (a value import would pull the ClickHouse client into the browser bundle).
 *
 * Levels: `paused` (imports are waiting for disk space; wins over the rest, it is what the operator is waiting for),
 * `critical` and `warn` (the passive disk watcher's status, lib/disk-watch.ts). `ok`, `unknown` and "not known yet" show nothing:
 * a transient unreadable disk already logs and shows in the Ingest Health panel, and a permanent banner for it would teach the
 * operator to ignore banners.
 */
import type { DiskReading } from '@/lib/disk-watch'
import type { IngestDiskGateState } from '@/lib/ingest-disk-gate'

export type DiskBannerLevel = 'warn' | 'critical' | 'paused'

export interface DiskBanner {
  level: DiskBannerLevel
  message: string
}

/** The body of GET /api/monitoring/disk. */
export interface DiskBannerPayload {
  disk: DiskReading | null
  gate: IngestDiskGateState | null
}

const GiB = 1024 ** 3
const gib = (bytes: number) => `${(bytes / GiB).toFixed(1)} GiB`

export function describeDiskBanner(disk: DiskReading | null, gate: IngestDiskGateState | null): DiskBanner | null {
  if (gate?.paused) {
    const free =
      gate.freeBytes === null
        ? `free space could not be read${gate.error ? ` (${gate.error})` : ''}`
        : `${gib(gate.freeBytes)} free, floor ${gib(gate.floorBytes)}`
    return {
      level: 'paused',
      message: `Imports are paused: ${free}. They resume by themselves above ${gib(gate.resumeBytes)}.`,
    }
  }
  if (!disk || (disk.status !== 'warn' && disk.status !== 'critical')) return null
  if (disk.freeBytes === null || disk.totalBytes === null || disk.freeRatio === null || !disk.thresholds) return null

  const space = `${gib(disk.freeBytes)} free of ${gib(disk.totalBytes)} (${Math.round(disk.freeRatio * 100)}%)`
  const jobs = `Dedup and projection jobs ${disk.status === 'critical' ? 'are blocked' : 'stop'} below ${gib(disk.thresholds.criticalBytes)}`
  const imports = gate?.enabled ? `; imports pause below ${gib(gate.floorBytes)}` : ''
  return disk.status === 'critical'
    ? { level: 'critical', message: `Disk critical: ${space}. ${jobs}${imports}.` }
    : { level: 'warn', message: `Disk is getting low: ${space}. ${jobs}${imports}.` }
}
