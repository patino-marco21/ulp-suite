# File ledger: know every file that was imported, skip the same bytes under another name, and keep the chat app from offering a download again — design (2026-11-07)

Date: 2026-11-07
Status: **Built and rehearsed; deployment is recorded under "Results" when it happens.**
Related: `2026-10-12-source-archive-and-ingest-gate-design.md` (the archive and the identity columns of `ulp.sources`), `2026-10-02-novelty-aware-ingest-design.md` (why a repeated import costs time and disk, not data), `2026-11-05-known-share-preflight-design.md` (near-duplicates, a different problem).
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

The owner asked how to keep track of every file that was ingested, so the same one is not downloaded and ingested again. Measured on 2026-11-07 (read-only):

- `ulp.sources` held 921 rows. 716 carried a sha256, a size and an archive id; 205 carried none (204 of them with size 0, together 2.41 billion lines of history), so they matched by name only. The archive manifest (content addressed) held 708 ids.
- The same-name check (`querySourceAlreadyImported`) starts from the file NAME. A name and a size the table holds, with a hash on record, are compared by content (ticket 05, 2026-11-06). The same bytes under another name were not seen. Eight content hashes were already recorded under more than one name: five were deliberate parser re-feeds (a name with "refeed" in it), three were accidental copies ("(2)", an extra suffix).
- A file that yielded no credential left no row, so it was read again every time it came back: 21 invented-looking lists and 5 empty files from October and November had no row.
- A missed duplicate costs time and disk, never data: a 258M-line re-feed under new names added 72,088 rows, took 14.0 minutes, took free space from 175 to 107 GiB for ten minutes (stage tables) and left 15.6 GiB of extra plaintext in `done/`.
- Nothing local remembered what had been downloaded: the chat client's download folder held 2,776 files of which 13 were 1 MB or more; the dumps are moved into the inbox, and after the move the client offers the download again.

## Decisions

1. **Hash every plain file at the gate.** `processTextFile` reads the file once (4 MiB chunks, with beats for the stall watchdog) and hashes it: 10.0 s for 2 GB on this machine (about 200 MB/s, no SHA-NI), so about 21 s for a 4.18 GB file against 8-10 minutes to import it. The hash is recorded in `ulp.sources` with the size at import time; before, a plain file's hash only arrived when the archive timer ran.
2. **Skip the same bytes under another name, but only while the parser is current.** `ulp.sources.parser_revision` (DDL v31, `UInt16`) records the revision of the line parser (`lib/parser-version.ts`, v6.5 = 65). A file whose hash is in the ledger under another name is skipped (job note `same-content`) when that row's revision is at least the running one. If the parser has changed since, the bytes may now yield rows, so the file is imported again and its new row carries the current revision; the next copy is skipped. The same-name check keeps its meaning and its note (`already-imported`); the content lookup excludes the file's own name.
3. **A name with "refeed" in it is always imported.** Re-feeding after a parser change was already done by renaming the plaintext (5 of the 8 hashes above); the marker makes that explicit and tested. `PARSER_REVISION` must be bumped by any parser change that can add rows from an earlier file (`CLAUDE.md` says so).
4. **Remember a file that yielded nothing.** With its identity known (hash and size) the staged path records the file with 0 lines even when it parsed nothing. ZIP entries and archive references are unchanged: a ZIP entry has no size, and a name-only row would block every later entry of that name.
5. **The guard learns about the hash and the size together.** A plain file now carries both, so the same-name query decides a row with a hash by the hash and a row without one by the size (`sourceGuardQuery`). Without this, a row recorded with a size and no hash yet would have blocked a file of that name with another size.
6. **A ledger that cannot be read never keeps a file out.** A failed content lookup is logged and read as "no match". `INGEST_CONTENT_LEDGER=off` restores the earlier rule (a file is read only when the table holds a hash for its name and size).
7. **No name-only rows from the job log.** 248 files from May and June are in the job log and not in the ledger. Writing size-0 rows for them would block ANY future file of that name, and generic names are reused with new content (the same-name check compares sizes for that reason). They are listed in the plain-text copy instead (kind `jobs`).
8. **A plain-text copy of the ledger.** `scripts/ledger-export.ts` writes `~/Desktop/ulp-ledger.tsv` (outside the repository; it holds names): one line per `ulp.sources` row and one per completed job with no row. The archive timer refreshes it on every tick, whatever the inbox is doing. It is what a person greps before downloading and what the two tools below read.
9. **Check before downloading.** The chat client's JSON export always writes `file_name` and `file_size` for a document, with the file included or not (read from the client's export code), and has a date range. `scripts/ledger-check.ts` reads an export and sorts the files into NEW, DIFFERENT-SIZE (the name is used, with another size), LOCAL (the download folder has it) and HAVE (the ledger has name and size). Only name and size are in the export, so this is a filter; the importer's content check is the safety net. It never uses the owner's chat session or the client's data folder.
10. **Stand-ins keep the chat app from offering the download again.** The client keeps a message "downloaded" while the file at the recorded path exists with the same size and modification time (`Core::FileLocation::check`), and its Downloads list keeps an entry while the size matches. `scripts/take-to-inbox.ts` moves a download into the inbox (a rename, so the time is kept) and leaves a sparse file of the same name, size and time (no blocks, no disk). For a download whose bytes are already ingested AND held by the source archive's manifest it swaps the download for a stand-in without moving anything; a download that is ingested but not archived stays. `--refeed` moves bytes an older parser imported under a name with "refeed" in it. Dry run by default; every stand-in is listed in a registry next to the ledger copy; a file that is already a stand-in is skipped. **Not tested in the chat app itself** (that needs the owner's session): the owner tries one small file first. The client rejects records over 4000 MiB, and the largest dumps (4,179,307,720 bytes) are 15 MB under that.

## What was measured (filesystem and parts)

- A stand-in of the largest done file: same size and modification time to the nanosecond, 0 bytes of disk.
- The unit tests create stand-ins in a temp folder and compare size, `mtimeNs` and `blocks` with `stat`; they move a file by rename and check the time is unchanged on the moved file and on the stand-in.

## Not built

- Name-only ledger rows for the 248 older job-log names (decision 7).
- A check inside the importer for ZIP entries: they have no file to hash up front.
- Reading the chat client's own records (its data folder holds the account session).
- A downloader: the third-party `tdl` has `--skip-same` (name and size against the destination folder) and needs its own login to the owner's account.

## Results

(filled in when the rehearsal and the deployment have run)
