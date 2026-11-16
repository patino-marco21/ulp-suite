# Reduced archive, stages A and B (build + shadow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every imported file, keep a second archive entry that holds only the lines that added something (the credentials this file was first to store, plus every line nobody can explain), and prove per file that importing that entry again reproduces exactly the rows the file stored. Nothing is deleted and no policy changes in this plan (shadow mode).

**Architecture:** The importer's own parser (`parseULPStream`) gets an opt-in span tracking mode (`trackSpans`): it reports the byte range of every credential record and of every rejected line worth keeping. The writer (`lib/reduced-archive.ts`) parses a source with tracking, loads the credentials into a scratch table in ClickHouse, asks the database which of them this file was first to store, copies exactly those byte ranges (plus kept rejects) into a reduced plaintext, archives it as zstd frames in `<archive>/reduced/` (own manifest, so the whole-file entries and every existing tool stay untouched), then proves it: the reduced entry is parsed by the same parser into a second scratch table and its keys are compared with the database rows of that file. A mismatch means no reduced entry is kept for that file.

**Tech Stack:** TypeScript, vitest, `lib/source-archive.ts` (frames, manifest, verify), `docker exec clickhouse-client` for scratch tables (the pattern of `lib/known-share.ts`), the isolated stack of `docker-compose.rehearsal.yml` for the proof.

## Global Constraints

- Owner rule: T3 lines are excluded from the reduced entry; intake is plain `.txt` only.
- Parser output must not change (no `PARSER_REVISION` bump); span tracking is off on the import path and costs nothing there.
- Dropped for good in the reduced entry, only these: lines whose credential another file stored first ("known"), repeats inside the file, blank separators, tier-dropped (T3) lines. Everything else stays: new credentials, credentials no row holds ("absent"), and every rejected line that is not blank/dedup/tier-dropped.
- A record is kept or dropped as a whole: a labelled block together with the separator that closed it, a positional url/login/password triple.
- `ULP_REDUCED_ARCHIVE=off|shadow` (default off). `on` is stage C and is not implemented here.
- The reduced writer never touches whole-file entries, `latestByName` results, `ulp.sources`, the replace gate or the stand-in logic.
- Disk guard: no reduction starts with less than 80 GiB free on the archive filesystem.
- Public repo: committed text carries numbers and reasons only (no file names of data, no search terms, no credential values); tests use invented data.
- ClickHouse behaviour is proven on the isolated rehearsal stack (`scripts/e2e-reduced-archive.ts`), not by mocks alone.

## File Structure

- Modify `lib/ulp-parser.ts`: `ParseStreamOptions.trackSpans`, `StreamBatch.spans`, `StreamBatch.kept`.
- Create `lib/reduced-archive.ts`: ranges (normalise, merge, copy), the entry type and its manifest, scratch SQL builders, the TSV writer, `reduceSource`.
- Create `lib/clickhouse-cli.ts`: `ChCli` (docker exec clickhouse-client: query, insert from an async iterable of TSV, query to a file).
- Create `scripts/reduce-archive.ts`: `run`, `status`, `verify` commands, the shadow log, the gate counter.
- Modify `scripts/archive-when-idle.ts`: after the archive step, run `reduce-archive.ts run` when `ULP_REDUCED_ARCHIVE=shadow`.
- Create `scripts/e2e-reduced-archive.ts`: rehearsal on the isolated stack.
- Tests: `__tests__/ulp-parser-spans.test.ts`, `__tests__/reduced-archive-ranges.test.ts`, `__tests__/reduced-archive-writer.test.ts`, `__tests__/reduced-archive-manifest.test.ts`.
- Modify `docker-compose.yml`? No: the writer runs on the host from the checkout, like the other archive tools. `.env.example` and the README get the new setting.

---

### Task 1: Span tracking in the parser

**Files:** Modify `lib/ulp-parser.ts` (`parseULPStream`, `StreamBatch`, `ParseStreamOptions`); Test `__tests__/ulp-parser-spans.test.ts`.

**Interfaces:**
- Produces: `ParseStreamOptions.trackSpans?: boolean`. With it on, each `StreamBatch` has `spans: number[]` (flat `[start0, end0, start1, end1, ...]`, aligned with `credentials`, byte offsets into the file, `end` exclusive and after the line's newline when it has one) and `kept: number[]` (flat start/end pairs of rejected units to keep: every rejected unit except blank, dedup and tier_dropped; adjacent units merged). Off: both absent, no allocation.

- [ ] Write failing tests: (1) an inline line's span slices back to that line; (2) a labelled block's span covers first label through its closing separator; (3) a url/login/password triple's span covers the three lines; (4) a no_fields banner is in `kept`, a blank line, a tier-dropped line and an in-file android repeat are not; (5) CRLF and a last line without newline; (6) differential: for 300 random mixed inputs, `credentials` and `breakdown` with tracking equal those without; (7) `spans.length === 2 * credentials.length` per batch.
- [ ] Run, see them fail (`spans` undefined).
- [ ] Implement: unit offsets (`base` of the buffer, running per line, forced flush of an over-long line keeps exact offsets), `urlStart`/`parkedEnd` for positional records, `blockStart` for blocks, flush with the separator's end, `pushKept` merging adjacent ranges, spans pushed where `batch.push(cred)` happens.
- [ ] Run the new tests, the existing parser tests and the parser fuzz test (`__tests__/ulp-parser*.test.ts`); all green.
- [ ] Commit `feat(parser): opt-in span tracking for the reduced archive writer`.

### Task 2: Ranges

**Files:** Create `lib/reduced-archive.ts` (ranges part); Test `__tests__/reduced-archive-ranges.test.ts`.

**Interfaces:**
- Produces: `normalizeRanges(starts: number[], ends: number[]): Array<[number, number]>` (sorted, overlapping or touching ranges merged, empty ranges dropped); `copyRanges(stream: AsyncIterable<Buffer>, ranges, write: (b: Buffer) => void): Promise<number>` (copies exactly those bytes, adds a final `\n` when a kept range ends a file without one, returns bytes written).

- [ ] Tests: unsorted + overlapping + touching merge; empty input; ranges across chunk boundaries (chunk size 3); range ending at EOF without newline gets one; ranges outside the stream are an error.
- [ ] Implement, run, commit `feat(reduced-archive): range union and copy`.

### Task 3: ClickHouse CLI wrapper

**Files:** Create `lib/clickhouse-cli.ts`; Test in `__tests__/reduced-archive-writer.test.ts` (fake) and the rehearsal (real).

**Interfaces:**
- Produces: `interface Ch { run(sql: string): Promise<string>; insertTsv(sql: string, rows: AsyncIterable<string>): Promise<void>; queryToFile(sql: string, path: string): Promise<void> }` and `dockerCh(container: string, opts?: { maxSeconds?: number; maxMemory?: number }): Ch` (`docker exec -i <container> clickhouse-client`, a failure throws with the last stderr lines, never the SQL values).

- [ ] Implement `dockerCh` with backpressure on stdin, run `INSERT ... FORMAT TSV` as one streaming process. Covered by the rehearsal; a fake `Ch` is used for unit tests.

### Task 4: The entry, its manifest and the scratch SQL

**Files:** `lib/reduced-archive.ts`; Test `__tests__/reduced-archive-manifest.test.ts`.

**Interfaces:**
- Produces: `ReducedEntry extends ManifestEntry` with `of: { sha256: string; size: number; lines: number }`, `credentials: number` (distinct keys kept), `kept_lines: number`, `absent: number`, `extra_known: number`, `verified_at: string`; `reducedDir(archiveDir)` = `<archive>/reduced`; `readReduced(archiveDir)` / `appendReduced(archiveDir, entry)` (own `manifest.jsonl`, same format and fsync as the main one); `scratchDdl(table)`; `classifySql(...)`; `checkSql(...)`.
- Scratch table `default.zz_reduced_<pid>_<rand>`: `(seq UInt64, s UInt64, e UInt64, url String, email String, password String, k UInt64 MATERIALIZED <normKeySql>) ENGINE = MergeTree ORDER BY tuple()`.
- Classification per slab `i` of `K` (`k % K = i`): first occurrence per key (`ORDER BY seq LIMIT 1 BY k`), left-joined with `SELECT norm_key_hash AS k, max(source_file = {name}) AS mine, 1 AS present FROM ulp.credentials WHERE norm_key_hash IN (slab keys) GROUP BY k`; a row is kept when `present = 0` (absent) or `mine = 1` (stored by this file); dropped when `present = 1 AND mine = 0` (known).

- [ ] Tests: the manifest round trip, that `latestByName(readManifest(archive))` never sees a reduced entry, SQL builders reject a bad table name and quote the file name.
- [ ] Implement, commit.

### Task 5: The writer with its proof

**Files:** `lib/reduced-archive.ts` (`reduceSource`); Test `__tests__/reduced-archive-writer.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–4, `openSource`/`archiveFile`/`verifyEntry` from `lib/source-archive.ts`, `preflightHardDrop` + `parseIngestPolicy` for the same T3 and soft policy the importer applies.
- Produces: `reduceSource(source: Source, opts: { name: string; archiveDir: string; ch: Ch; workDir: string; env?: NodeJS.Dict<string>; now?: () => Date }): Promise<ReduceOutcome>` where `ReduceOutcome = { ok: true; entry: ReducedEntry } | { ok: false; reason: 'mismatch' | 'no-rows' | 'error'; detail: string; stats: ReduceStats }`.

Steps inside: parse with tracking → soft policy filter as the importer does (same `shouldDropAtIngest`) → TSV rows into the scratch table → classify slab by slab → kept credential spans + kept rejects → `normalizeRanges` → copy ranges from a second read of the source into a `.reduced.part` plaintext → proof (parse that plaintext into a second scratch table; `missing` = keys the database holds for this file that the table lacks; must be 0; `extra_known` counted) → `archiveFile` into `reduced/` → `verifyEntry` → append the manifest. Scratch tables and temp files are removed in `finally`.

- [ ] Tests with a fake `Ch` that implements the three statements over an in-memory map (key = `${url}\0${email}\0${password}` lower-cased the way the SQL would): a file of new + known + repeat + blank + banner + T3 lines reduces to exactly new + banner; a block and a triple survive whole; a fake database that lacks a key the file stored makes `missing > 0` and the outcome `mismatch` with nothing appended to the reduced manifest; a source that is only known lines gives `no-rows`; scratch tables are dropped on every path including errors.
- [ ] Implement, run, commit.

### Task 6: The command, the shadow log and the gate

**Files:** Create `scripts/reduce-archive.ts`; modify `scripts/archive-when-idle.ts`; `.env.example`, `README.md`.

- [ ] `run [--only a,b] [--limit N] [--pilot N] [--floor-gib 80]`: candidates = names in the whole-file manifest that are in `ulp.sources` and lack a reduced entry for the same sha256; `--pilot N` takes N old entries at random (smaller than 2 GiB first); disk guard; one run at a time (lock in `reduced/`); appends `reduced/shadow-log.jsonl` (`{name, at, ok, reason, stats}`); prints counts only, never a line of a file.
- [ ] `status`: reduced entries, bytes, share of the whole-file bytes for the same names, consecutive ok results from the newest (new files only), failures by reason.
- [ ] `verify [--sample n]`: `verifyEntry` over reduced entries.
- [ ] `archive-when-idle.ts`: when `ULP_REDUCED_ARCHIVE=shadow`, run `reduce-archive.ts run --limit 20` after the archive and replace steps; its failure never fails the archive run (a note in the account).
- [ ] Unit test the pure parts (candidate selection, gate counter) in `__tests__/reduced-archive-manifest.test.ts`; commit.

### Task 7: Rehearsal on the isolated stack

**Files:** Create `scripts/e2e-reduced-archive.ts` (header says how to run, as the other e2e scripts).

- [ ] Bring up `docker-compose.rehearsal.yml` ClickHouse, import a generated corpus through the real importer path (`processTextFile`) in this order: file A (new rows), file B (overlaps A by half + repeats + banner + a labelled block + a triple + a T3 line), file C (all known). Reduce A, B, C; assert: B's reduced entry re-imported into an empty table yields exactly B's stored rows; C gives `no-rows`; A is within a few lines of A; a deliberately deleted row in the database makes the proof fail for that file; scratch tables are gone.
- [ ] Time the proof query on the live-size table separately (read-only) and record the number in the spec.
- [ ] Commit; run typecheck of app, `scripts/`, `__tests__/`, then test, lint, build (CI gate).

### Task 8: Roll out in shadow

- [ ] Tag the running image (`docker tag ... rollback-<UTC>`), no image rebuild is needed (the writer runs on the host), set `ULP_REDUCED_ARCHIVE=shadow` in the archive service unit, restart nothing else.
- [ ] Pilot: `reduce-archive.ts run --pilot 50`, report exact/mismatch counts and the size ratio against the measured 11–26%.
- [ ] Let the timer write reduced entries for new files; report at 200 consecutive exact results. Stage C and D wait for the owner's yes.

## Self-review

Spec coverage: writer on the importer's parser (T1), proven-drops-only (T1 + T4 SQL), unexplained lines kept (T1 `kept`), per-file round trip with fall-back to "no reduced entry" (T5), flag (T6), shadow beside whole-file entries with a separate manifest (T4), pilot and gate (T6, T8), disk guard (T6), TDD + rehearsal + rollback tag (T1–T8). Not in this plan, by design: replace gate, stand-in gate, restore rule (stage C), compaction (stage D).

## What building and the first real files changed (2026-11-15)

- **Files.** The shadow selection, the log and the gate live in `lib/reduced-shadow.ts`, the ClickHouse statements in `lib/reduced-archive-ch.ts`; tests are `ulp-parser-spans`, `reduced-archive-ranges`, `reduced-archive-writer`, `reduced-shadow` and `clickhouse-cli` (there is no `reduced-archive-manifest` test file).
- **No `no-rows` outcome.** A file that added nothing reduces to an empty entry (size 0), which is a good result, not a failure.
- **The proof splits loss from drift.** The first real files showed 0.15 to 0.22% of the rows stored for a file are ones an older parser version made and today's parser does not (the 0.24% gap of the first measurement). Those cannot be reproduced from the file by anyone, so they are `drift` (reported; a new file with drift is not exact for the gate), and `missing` counts only keys today's parser makes from the file that the reduced entry lacks.
- **A blank line between kept ranges.** Dropping a known line between two kept junk lines could join a lone url, a login-looking line and a plain word into a record the original never had; a test reproduced it and the separator fixes it.
- **ClickHouse refuses an insert of no rows** (`NO_DATA_TO_INSERT`): found by the rehearsal, fixed in the wrapper.
- **Time.** About 55 s per file for the two scans of `ulp.credentials` plus about 0.6 s per MB; a 50-file pilot is hours, so `run` has a time budget and is called again.

## What the pilot of 51 old files changed (2026-11-15, evening)

The pilot (files up to 2 GiB) reduced 42 files exactly and failed 9: 2 were the strict-rule leftovers (every key they would lose is drift), 5 had a few extra credentials appear in the reduced copy (4 of them rule B, 1 a line over 1 MiB), 2 hit ClickHouse's memory limit. With the fixes below, the nine re-run on the live table in a scratch archive: 8 reduce exactly (the two leftovers with their drift, the four rule B files, and the two memory files of 1.40 and 1.70 GiB, in 19 and 25 minutes), and the ninth is left whole as `long_line`.

- **Rule B of the parser keeps state across a file.** It drops the repeats of an Android (login, password) pair that lost its scheme, per file. If the first line of a pair is left out of the reduced copy (another file stored it) and a later repeat is copied (it sits inside a kept block, an unfinished labelled block that swallows lines up to its separator), the repeat no longer looks like one and the parser makes a credential the original never had. Reproduced with the parser alone: all 16 extra credentials of the file I probed were of this kind. The parser now reports, with `trackSpans`, each dropped repeat with the span of the first line of its pair (`StreamBatch.androidRepeats`); the writer copies that first line whenever it copies the repeat (`androidFirstsToKeep`). The first line comes along as a known line inside the reduced entry (counted in `extra_known`, not a mismatch). No other state outlives a line: `seen` is off with `dedupInFile: false`, and the block and positional states end at the blank line between kept ranges.
- **Memory.** The keep statement joined the whole holders table in every slab and the proof built sets of every key: about 150 bytes a row, so 20 million parsed rows used 3.0 GiB against the 4 GB limit of one statement (a 1.4 GiB file failed), and a 4 GiB file (48 million rows) would need about 7 GiB. Files over ~23 million lines are 13-14% of the archive's files and 66-69% of its bytes. Raising the limit was rejected (ClickHouse has a 14 GiB server ceiling, ~2 GiB in use, and an October out-of-memory incident). The statements are now cut into slabs of 10 million parsed rows (`k % slabs = slab`): the keep statement joins only its slab of the holders, the proof runs per slab and adds the counts, and what the database holds under the name is asked once. Measured on a synthetic scale test that matched the real number (2.98 GiB at 20 million rows): 48 million rows peak at 1.2-1.3 GiB for the keep statement and 0.4 GiB for the proof with slabs of 8 million; the holders statement peaks at 0.85 GiB for 8 million keys on the live table. The price is one more pass over `ulp.credentials` (50-85 s) for each slab: ~1,900 passes for the whole archive against ~1,200, an estimated 10-17 more hours in stage D, about 5 minutes more for a 4 GiB file.
- **The script's own memory.** The list of kept spans is a `number[]` and two typed-array copies: 48 million spans (an all-new 4 GiB file, the worst case) peak at 3.2 GB of resident memory against Node's 4.3 GB heap limit; a usual file is under 1 GB. Not changed.
- **Files that do not shrink.** An unfinished labelled block keeps everything up to its separator; 4 of 40 reduced pilot files stayed 90-100% kept (and with them the pilot's 35% overall is 27% without them). Not changed.
- **A line over 1 MiB cannot be reproduced.** The parser cuts such a line where its buffer stands when it passes the limit, or reads it whole when its end arrives first, so the credentials it makes from the line depend on how the bytes are chunked (a real file with four such lines of 1.5 to 2.1 MB: the four credentials differed under 64 KiB, 1 MiB, 3 MiB and 64 MiB chunks). The importer itself is subject to it, so the rows stored for such a line are an artefact of the import's chunking and no reader, the reduced entry's included, reproduces them. The parser counts the lines over the limit (`overlongLines`, with `trackSpans`; by length, not by whether a cut happened, because a line read whole by one chunking is cut by another) and the writer stops with `long_line` right after the parse: no entry, not a failure, the file keeps its whole-file entry, the gate neither counts nor stops at it, `--retry-failed` does not try it again, and `status` counts these files apart.

## What the compaction changed (2026-11-16)

Why: 6 of the files over 2 GiB (the size class that holds 61% of the archive's bytes) kept 14% to 100% of their bytes, 83.5% together, against 38% for the small ones; stage D would have freed about 75 GiB of the 202 GiB. The cause is the unfinished labelled block: it keeps everything up to the blank line that closes it, a dense file has almost none, and so one record covers nearly all of the file and holds millions of credentials other files stored first.

- **What it does.** Inside the kept ranges, the bytes of a credential the file did not add (known to another file, or a repeat inside the file) are cut out, and one line `#` stands where each run of them was (`lib/reduced-archive.ts`: `holesToCut`, `cutRanges`, `copyRanges` with its `holeBefore` marks). A blank line would end a block the original still had open; `#` is read as neither a credential nor a label, and ends a pending lone url exactly as the credential that stood there did (a test with the real parser).
- **Nesting decides what is cut.** First design: protect every kept credential's span. A probe on a real file showed 1,863,373 of its 1,863,889 credential spans nested in one kept record that covers the whole file (the record is emitted last), so that design would have cut nothing. The rule is now: every byte belongs to the innermost credential whose span covers it; bytes of a dropped credential are cut, bytes of a kept one, of the Android first lines that `androidFirstsToKeep` asks for and of anything no credential covers (labels, unexplained text) stay. The parser emits a record after what is nested in it, so one stack over the spans in emission order finds the nesting in a single pass; spans that overlap without nesting, or arrive out of file order, make the answer empty (nothing is cut) rather than a guess.
- **The proof stays the gate, with a fallback.** The compacted copy is parsed and compared like any copy; if it has a missing or spurious key, the entry is written once more with the spans whole and proven again (the second proof recreates the reduced rows and does not read the stored keys twice). The entry says what happened: `placeholders` (0 after a fallback; absent on entries written before the compaction), and the result carries `compactFallback`.
- **Measured, real files, exact (0 missing, 0 spurious, no fallback):** 100.0% to 35.2% (0.135 GiB), 99.8% to 42.5%, 99.7% to 25.1% (0.10 GiB); the probe's prediction for the first was 35.2%. The estimator that ignored nesting had said 50% for a small file and 24.5%, 35.5%, 29.0% for three big ones.
- **Writer memory.** One extra pass over the spans: two typed arrays of one number per credential (about 0.9 GB for 54 million credentials) and the list of holes, next to the list of spans (0.9 GB). The writes to the plain file are batched into 1 MiB (a placeholder line, a newline and a credential were one write each).
- **Commands.** `reduce-archive.ts run --recompact-over N` makes the reduced entry again of the files whose entry was written before the compaction and kept N percent or more of the file, the biggest entry first; the old entry stays in the manifest (superseded by the later line for the same bytes) and on disk. `--only-sha` names a file by the start of its sha256, for a name with a comma in it (`--only` splits on commas). `status` prints how many reduced files carry placeholder lines and how many fell back.
- **Rehearsal.** `scripts/e2e-reduced-archive.ts`: file K (an unfinished block with 20 known credentials, 10 new ones and repeats), file M (a block that closes into a credential of its own and holds 20 known and 10 new), the fallback with a placeholder the parser reads as a credential (the second proof on the real ClickHouse), K and M in slabs, and the new flags of the command: 52 of 52.

