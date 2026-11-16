# Reduced archive: keep only the lines that added something — design (2026-11-15)

Date: 2026-11-15
Status: **Stages A (the writer) and B (shadow mode) built; C (switch new files to reduced entries only) and D (compact the old archive) are NOT built** and wait for the owner's yes after the shadow results. In shadow mode nothing is removed, replaced or switched: a reduced entry is written beside the whole-file entry and every other tool still reads the whole-file entries. Plan: `docs/superpowers/plans/2026-11-15-reduced-archive.md`. Proof: `scripts/e2e-reduced-archive.ts` on the isolated ClickHouse.
Related: `2026-10-12-source-archive-and-ingest-gate-design.md` (the archive this sits beside), `2026-11-01-near-duplicates-design.md` (look-alike rows), `2026-11-07-download-mover-design.md` (stand-ins).
File names, search terms and credential values are deliberately absent (the repository is public); the tests use invented data.

## Why

The database stores every credential once (0 exact duplicates in a 1/64 key sample of 50.8 M rows; 5.6% of rows are look-alikes that differ in `www.`, capitals or a trailing slash). The archive stores every file whole, so a credential that appears in many files is archived again for each of them: 1,084 archived files, 11.96 B lines, 637 GiB of source, 201 GiB on disk, about 4 to 5 copies of an average entry and a rare tail of 100 or more. The novelty check (2026-10-11) and the archive (2026-10-12) were built a day apart and never connected. Nothing requires the known lines: the archive's job is to replace the plaintext and to let a better parser read the file again.

Measured on 8 archived files (1.27 GB, 21 M lines): an entry that keeps only the lines new in its file plus the rejected lines a better parser could rescue is 20.3% of the original (2.4% for a file that was 1% new, 49% for one that was 76% new). Projected on the last week of real files: 11.4% of today's size, archive growth 62 GiB a week to about 7 GiB; compacting the 202 GiB already there would free about 140 to 150 GiB. The disk runway at 215 GiB free and a 50 GiB ingest pause is about 1.3 weeks today.

## What a reduced entry holds

Per file, kept:

- the first line of every credential **this file stored** (the database holds a row for its normalised key under the file's name),
- the credentials **no row holds** (`absent`: stored once, removed since),
- **every rejected unit nobody has explained** (no field split, no password, garbage, a banner), because a better parser may read it,
- a labelled block with the separator that closed it, and a url / login / password triple, **whole**.

Dropped, and only these, because each is proven to carry nothing:

- a credential another file stored first (`known`), whatever its look-alike spelling (the normalised key decides),
- a repeat inside the file (the first occurrence is kept),
- a blank separator,
- a tier-dropped line (tier T3 with the keep-list of countries, and the soft ingest policy): the owner's rule is no T3 lines.

A blank line goes between two kept ranges. The parser's state (a url waiting for its login, a block) ended in the original at the line that closed it; without a separator, a lone url, a dropped known line and two plain lines behind it would read as one record the original never had (a test reproduces it).

## How it is written

`parseULPStream` has an opt-in `trackSpans` mode (off on the import path; parse speed on a 3 M-line file is the same within noise, 22.4 to 22.8 s against 21.9 to 23.2 s). It reports the byte range of every credential record and of every rejected unit worth keeping; the parser reads the file as Latin-1, so a character offset is a byte offset in the file. The writer parses the whole-file entry with the importer's own parser and policy, loads the credentials into a scratch table in ClickHouse (`default.zz_red_*`, four tables, dropped always), asks `ulp.credentials` for the holders of their normalised keys, and copies the kept ranges out of a second read of the archive into a plain file, which is archived like any entry (zstd frames of 64 MiB, level 12, content addressed).

Layout, in `<archive>/reduced/`: `manifest.jsonl` (the usual manifest fields for the reduced plaintext, plus `of` = the whole-file entry's sha256/size/lines, `credentials`, `kept_lines`, `absent`, `extra_known`, `db_rows`, `db_keys`, `db_drift`, `verified_at`), `<id>.zst`, `shadow-log.jsonl` (one line per attempt), `shadow.json` (when the shadow began), `work/` (the plaintext while it is built; the archive's filesystem, not `/tmp`, which is RAM here). A separate manifest keeps `latestByName` of the whole-file manifest, `status`, `verify`, the replace gate, the stand-ins and `restore` exactly as they were.

## The proof

A reduced entry is only kept when it passes:

1. The archive entry is decoded and hashed while it is parsed; it must equal its manifest line.
2. The reduced plaintext is parsed again, by the same parser, into a second scratch table. Against the rows `ulp.credentials` holds under the file's name:
   - **missing** = keys the file stored that today's parser makes from the file and that the reduced entry does not make. Must be 0.
   - **spurious** = keys the reduced entry makes that the original does not. Must be 0.
   - **extra_known** = keys only other files hold that came along inside a kept record. Reported, not a failure (a known line between the labels of a block is kept with the block).
   - **drift** = keys the file stored that today's parser does not make from the file at all. Reported, and the entry is still written: re-importing the whole file would not make them either, so reducing it loses nothing the parser sees, and the lines behind such a row are kept or dropped by what today's parser makes of them.
3. The written archive file is decoded and hashed again (`verifyEntry`).

A failed proof writes nothing (no entry, no file, no manifest line); the scratch tables and the plaintext are removed on every path.

**Drift was found on real files, and it explains the 0.24% gap** the first measurement could not account for (its classifier reproduced the stored rows exactly in 2 of 8 files and was short by 0.03 to 0.55% in the rest). In three old files tried: 580 of 378,085 and 689 of 313,770 stored keys (0.15% and 0.22%) are rows an older parser version stored and today's parser reads differently, which matches the roughly 5.9 M older rows with promo tails in the table (about 0.18%) found by the tail audit of 2026-11-02. The third file reduced exactly: 9.6% of its plaintext kept (16,168 new keys, 550,321 known dropped, 10,190 repeats, 0 known inside kept records), 72 s. A new file imported by the current parser should have drift 0, so a new file with drift is not counted as exact by the gate.

## Shadow mode (stage B)

- `ULP_REDUCED_ARCHIVE=shadow` in the archive service (`scripts/systemd/ulp-archive-auto.service`; only `shadow` turns anything on; `on` is stage C and stays off). `scripts/archive-when-idle.ts` runs `scripts/reduce-archive.ts run --limit 20 --inbox <inbox>` after the archive and replace steps, when the inbox has been idle; the tool stops starting files as soon as a file arrives in the inbox (the import comes first), and its failure never fails the archive run.
- `run` takes the files archived since the shadow began, oldest first. `--pilot N` takes N older files (a seeded pick, none over 2 GiB); `--only` names files. A file whose last attempt failed waits for `--retry-failed`. Nothing starts with less than 80 GiB free on the archive's filesystem (shadow burn is about 9 GiB a week for new files); one run at a time (a lock in `reduced/`); a time budget of 90 minutes.
- **The gate: 200 new files in a row that proved exact with drift 0** (about 4 days at 51 jobs a day). `status` prints the count, the share (reduced plaintext and on disk), the failures by reason, the pilot tally by file and the drift. `verify` decodes and hashes reduced entries.
- Cost on real files: 72 s for 57 MB (0.73 M lines), 133 s for 105 MB, 152 s for 145 MB, so about 1 to 1.4 s per MB, most of it two scans of `ulp.credentials` (the holders of the file's keys, then the keys stored under its name). Scratch tables are tens of MiB for these files; a 4 GB file's table is a few GB, which the disk floor covers.

## Stages C and D (not built)

- **C**, on the owner's yes after the gate: new files get the reduced entry only (the replace gate becomes "a verified reduced entry exists", the stand-in gate "imported, hash recorded, reduced entry verified"; restore refuses a reduced entry, because it is not the original file).
- **D**, on the owner's yes after the pilot: compact the old 202 GiB in batches, each old entry removed only after its reduced twin has verified, stopping at the first mismatch; files with a mismatch stay whole. Side-by-side copies of all old entries would need about 62 GiB the disk does not have, which is why D works in batches.
- What cannot be mitigated by code, and is the owner's to accept: the exact original is gone from the vault (the chat service remains the only other copy); "undo a deletion by re-feeding the file" no longer returns lines other files shared; T3 lines are gone locally; the 32.9% of known lines whose first holder is a file with no archive entry (imports from before the archive) would live only in the database.

## Proven by

`__tests__/ulp-parser-spans.test.ts` (offsets of every record kind, a differential check that tracking changes nothing parsed, over-long lines flushed in pieces), `__tests__/reduced-archive-ranges.test.ts`, `__tests__/reduced-archive-writer.test.ts` (what is kept and dropped, records whole, drift, a lossy writer failing the proof, a damaged archive refused, the gap separator), `__tests__/reduced-shadow.test.ts` (selection, gate, status), `__tests__/clickhouse-cli.test.ts` (back-pressure, errors that name only the ClickHouse code), and `scripts/e2e-reduced-archive.ts` on a real ClickHouse (5 files with known counts, a pre-normalised-key look-alike holder, a file name that needs SQL escaping, drift, a lossy writer, a missing container, the command end to end, no scratch table left). The rehearsal found one bug the unit tests could not: ClickHouse refuses an `INSERT` of no rows (`NO_DATA_TO_INSERT`), which an empty reduced entry produces.
