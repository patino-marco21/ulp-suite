/**
 * How long the phases of one import took, in milliseconds (docs/superpowers/specs/2026-10-12-fast-ingest-design.md, step A3). They are
 * stored as processing_jobs.parse_ms / check_ms / insert_ms. Before them the split could only be rebuilt from ClickHouse's query log.
 *
 *   parse_ms   the time the import waited for the parser. It counts the wait for a batch, so with the pipelined import only the part
 *              of the parsing that was not hidden behind an insert.
 *   check_ms   the existence check, per slab: clear the known table, fill it with the hashes the table already holds, count them.
 *   insert_ms  writing: the batches inserted into the stage table, plus the commit INSERT ... SELECT into ulp.credentials.
 *
 * Together they are close to the job's duration; the gates' pauses and the bookkeeping make up the difference.
 */
export interface PhaseTimings {
  parse_ms: number
  check_ms: number
  insert_ms: number
}

/** The timings of several imports added up (the entries of a ZIP). An import that carries none adds nothing. */
export function sumTimings(items: ReadonlyArray<{ timings?: PhaseTimings } | undefined>): PhaseTimings {
  const sum: PhaseTimings = { parse_ms: 0, check_ms: 0, insert_ms: 0 }
  for (const item of items) {
    if (!item?.timings) continue
    sum.parse_ms += item.timings.parse_ms
    sum.check_ms += item.timings.check_ms
    sum.insert_ms += item.timings.insert_ms
  }
  return sum
}
