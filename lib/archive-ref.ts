/**
 * The archive reference (docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md, "The importer reads the archive too").
 *
 * After `archive-sources --replace` there is no original left to hardlink into ./inbox, and restoring 140 GiB of plaintext would need 140 GiB of free space.
 * A tiny file `<name>.archiveref` dropped into ./inbox tells the importer to read that file from the source archive instead: no plaintext touches the disk,
 * and inbox/done keeps only the reference.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'

export const ARCHIVE_REF_EXT = '.archiveref'
const MAX_REF_BYTES = 64 * 1024
const ID_HEX = /^[0-9a-f]{24}$/
const SHA_HEX = /^[0-9a-f]{64}$/

export interface ArchiveRef {
  v: 1
  /** The archive file `<id>.zst`: the first 24 hex characters of the plaintext's sha256. */
  id: string
  /** The original file name: ulp.sources records it, the breach label is taken from it, and the same-name guard compares it. */
  name: string
  size: number
  sha256: string
}

export class ArchiveRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveRefError'
  }
}

/** The archive directory as the app sees it: docker-compose.yml mounts the host's ~/ulp-archive read-only at /archive. */
export function appArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ULP_ARCHIVE_DIR?.trim() || '/archive'
}

export function parseArchiveRef(text: string): ArchiveRef {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ArchiveRefError('the archive reference is not valid JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ArchiveRefError('the archive reference must be a JSON object')
  const r = raw as Record<string, unknown>
  if (r.v !== 1) throw new ArchiveRefError(`unsupported archive reference version: ${String(r.v)}`)
  if (typeof r.id !== 'string' || !ID_HEX.test(r.id)) throw new ArchiveRefError('the archive reference has no valid id (24 hex characters)')
  if (typeof r.sha256 !== 'string' || !SHA_HEX.test(r.sha256)) throw new ArchiveRefError('the archive reference has no valid sha256 (64 hex characters)')
  if (!r.sha256.startsWith(r.id)) throw new ArchiveRefError('the archive reference id is not the start of its sha256')
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 255 || /[/\\\0]/.test(r.name)) throw new ArchiveRefError('the archive reference has no valid file name')
  if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) throw new ArchiveRefError('the archive reference has no valid size')
  return { v: 1, id: r.id, name: r.name, size: r.size, sha256: r.sha256 }
}

export function readArchiveRefFile(path: string): ArchiveRef {
  const size = statSync(path).size
  if (size > MAX_REF_BYTES) throw new ArchiveRefError(`an archive reference is a few hundred bytes, this file has ${size}`)
  return parseArchiveRef(readFileSync(path, 'utf8'))
}

export function serializeArchiveRef(entry: { id: string; name: string; size: number; sha256: string }): string {
  return JSON.stringify({ v: 1, id: entry.id, name: entry.name, size: entry.size, sha256: entry.sha256 }) + '\n'
}

/**
 * Wraps the plaintext stream of an archive: every chunk is hashed on its way through. `digest()` is valid once the stream has been read to its end (it throws
 * before that), and gives the sha256 of exactly the bytes the parser saw.
 */
export function hashingStream(src: Readable): { stream: ReadableStream<Uint8Array>; digest: () => string } {
  const hash = createHash('sha256')
  let ended = false
  const web = Readable.toWeb(src) as ReadableStream<Uint8Array>
  const stream = web.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      ended = true
    },
  }))
  return {
    stream,
    digest() {
      if (!ended) throw new ArchiveRefError('the archive was not read to its end')
      return hash.digest('hex')
    },
  }
}
