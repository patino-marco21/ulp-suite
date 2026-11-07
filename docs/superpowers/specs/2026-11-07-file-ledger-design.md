# File ledger: know every file that was imported, skip the same bytes under another name, and keep the chat app from offering a download again — design (2026-11-07)

Date: 2026-11-07
Status: **Deployed on 2026-11-07 (code `e70755c` + `cac73a7`, image `7f84f8975bb3`, rollback tag `rollback-20261107-0728z` = the previous image `e22ee1cb9684`). Rehearsed: 352 of 352 ingest checks and 51 of 51 stack checks. The stand-in was verified in the chat app the same day (see "The sweep"); the sweep runs on the host with the archive timer.**
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

## The sweep (2026-11-07)

**Verified in the chat app.** One download (374 MiB) already ingested and archived was swapped for a stand-in. The message kept its "downloaded" glyph right after the swap and after
a full quit and reopen of the client. The restart is the real test: in the client's source (upstream Telegram Desktop; the fork was not read), a document created at start-up
re-reads its stored record through `Core::FileLocation::check()` (readable, same size, same modification time) and erases a record that fails; an unchecked glyph can only be
stale inside a running session. So a file moved without a stand-in loses its record at the next start, and a stand-in keeps it.

**Why a sweep.** Downloads that were ingested and archived still sat in the download folder, and the client does not know it can leave them. Six were back there after
being ingested (about 6.9 GiB), each downloaded again. `scripts/stand-in-sweep.ts` swaps, in the download folder, a file whose exact bytes the ledger knows as ingested AND the
source archive holds, for a stand-in; the archive timer runs it on every tick (`ULP_STANDIN_SWEEP=off` skips it, `ULP_DOWNLOAD_DIR` names the folder).

**Rules.** It never moves a file and never starts an ingest. Before it swaps it decodes the archive entry again (`verifyEntry`, the standard of `archive --replace`); it leaves a file
modified in the last 10 minutes; it re-checks the size and the modification time just before the swap, so a download that resumed meanwhile is left whole. A partial download
cannot match an archived sha256, so the sweep needs no "download finished" signal; this is why it only swaps and does not also move new files into the inbox (a stalled download
looks finished by size and time). Hashes are remembered by name, size and modification time: a folder of 27 files (about 8 GiB) took 77 s to read once and 0.4 s to sweep again.
`--restore <path>` decodes the archive entry back over a stand-in, with the original modification time; on a 374 MiB file the bytes and the time came back exactly.

**Measured on the real folder.** Dry run, then apply: 1 file swapped; 24 new downloads, 2 files the ledger knows by name and size only (no hash to compare), and 5 earlier
stand-ins left as they were; free space went from about 150 to 157 GiB with the earlier six swaps.

## What was measured (filesystem and parts)

- A stand-in of the largest done file: same size and modification time to the nanosecond, 0 bytes of disk.
- The unit tests create stand-ins in a temp folder and compare size, `mtimeNs` and `blocks` with `stat`; they move a file by rename and check the time is unchanged on the moved file and on the stand-in.

## Not built

- Name-only ledger rows for the 248 older job-log names (decision 7).
- A check inside the importer for ZIP entries: they have no file to hash up front.
- Reading the chat client's own records (its data folder holds the account session).
- A downloader: the third-party `tdl` has `--skip-same` (name and size against the destination folder) and needs its own login to the owner's account.

## Results

**Proof before the deploy** (candidate image built from `cac73a7`; the later commits only changed rehearsal scripts, which the image does not carry):

- Unit tests: the whole suite, 5,151 passed (307 files), typecheck of the app, `scripts/` and `__tests__/` and lint clean. New: the pure decision (`content-ledger`), the importer against a mocked database (skip, older parser, re-feed, ledger unreadable, file that yielded nothing, ledger off), the guard's four query shapes, DDL v31 in the migration tests, and 34 tests of the tools on real temp files (a stand-in has the size and the modification time to the nanosecond and no blocks, a move keeps the time, a name in the way is refused).
- Rehearsal on the isolated stack, real ClickHouse: the first run of the ingest scenarios passed 346 of 351; the five failures were the scenarios that import identical content twice under two names ON PURPOSE (they now use a name with "refeed") and one wrong expectation of the new scenario. The second run: **352 of 352**. The stack's own checks: **51 of 51** (a fresh ClickHouse built the `parser_revision` column from the init SQL, and the app recorded DDL 31).
- The new `ledger` scenario proves, on a real ClickHouse: the hash, size and revision are recorded at import; the same bytes under a new name are skipped (no row, no credential, job note `same-content`); a "refeed" name is read, not skipped (0 new, all known); bytes whose rows are put back to an older revision are imported again under a new name and the next copy is skipped; a file with no credential is remembered with 0 lines (a re-drop is skipped by name, a copy by content); a reused name with other content imports; the inbox watcher labels the skip; the plain-text copy lists the rows; the backfill dry run changes nothing and `--apply` sets only the rows at 0.

**Deployment** (2026-11-07, the inbox idle, no job in flight): the running image was tagged `rollback-20261107-0728z`, the candidate promoted, only the app container recreated (ClickHouse untouched, up since 2026-11-04). The app came up healthy with no restart; the log shows "DDL v31 applied"; the live `ulp.sources` has `parser_revision UInt16 DEFAULT 0`; the 921 rows are intact; `INGEST_CONTENT_LEDGER` is empty (on).

**Backfill** (`scripts/ledger-backfill.ts revisions --apply`, one mutation): 229 rows before the v6 parser (revision 50), 532 at v6.1, 127 at v6.2, 27 at v6.3, 2 at v6.4 and 4 at v6.5; a second run found no row at 0.

**The plain-text copy**: 921 ledger lines and 272 lines for files only the job log knows. A dry run of `take-to-inbox` on the real download folder (read-only) found two files of 1 MB or more: one new, one with a name the job log holds from before the ledger.

**Left to the owner**: run one small chat export through `ledger-check`, and name a deliberate re-feed with "refeed" in it. Not done: the stand-in marks only what the client has a record of; a file whose record was erased (moved before a stand-in existed) needs a client that reads the ledger.
