# Download mover and pipeline status: a finished download goes to the inbox by itself, the chat app keeps showing it as downloaded, and one page says whether it all works — design (2026-11-07)

Date: 2026-11-07
Status: **Built and running 2026-11-07** (`scripts/pull-downloads.ts` on a systemd user minute timer, `scripts/pipeline-status.ts`, pages in `~/Desktop/ulp-pipeline/`). Proved on the real machine with a synthetic file (below); the chat client's own behaviour while it writes a file is taken from its source and was not yet watched on a real download of the owner's.
Related: `2026-11-07-file-ledger-design.md` (the ledger, the stand-in, the sweep this extends), `2026-10-12-source-archive-and-ingest-gate-design.md` (the archive and the quality gate).
File names, channel names, search terms and credential values are deliberately absent (the repository is public); the pages the tools write list them and live outside the repository.

## Why

The owner wanted the whole path automatic: download a file in the chat client, and it reaches the inbox and is imported without a step by hand, while the client goes on showing the message as downloaded (also after restarts and reboots), and with one place to see whether the path works. The owner had also learned the hard way what moving too early does: a file moved while the client was still writing it keeps growing in its new place, and the importer, which read the file once, never sees the lines that came after.

The earlier design (the sweep) therefore only swapped files whose bytes were already archived and left new files to a by-hand tool: a partial download cannot match an archived hash, so the swap needs no "finished" signal, but a move does, and a stalled download looks finished by size and time. This design supplies the signal.

## What the client does while it downloads (from its source)

Upstream Telegram Desktop, `Telegram/SourceFiles/storage/file_download.cpp`; AyuGram is a fork and was not read, so the first real download is the acceptance test.

- The file is opened `WriteOnly` under its final name when the download starts (`checkForOpen`) and stays open until the download ends.
- Parts are written at their offsets (`writeResultPart` seeks), so an interrupted download can have holes. A finished one cannot: `finalizeResult` cancels when any skipped bytes remain.
- A cancelled or failed download closes and removes the file (`cancel`). A normal quit cancels every running download (`~mtpFileLoader`), so a partial file is deleted.
- The record that makes the message "downloaded" is written only after the file is closed (`finalizeResult` calls `writeFileLocation(... FileLocation(filename))` last).

So a file that no process has open is finished, and the one way a partial file stays behind is a client that was killed or lost power. On this machine the client runs in a Flatpak sandbox; its descriptors are still readable from the host (`/proc/<pid>/fd` showed its open files), and its download folder is the host's `~/Downloads/AyuGram Desktop`.

## Decisions

1. **Three gates, all must hold, before a file is looked at** (`lib/download-ready.ts`):
   - no process has the file open (a scan of `/proc/<pid>/fd` for the folder; the mover's own descriptors are left out);
   - the file has not changed for a quiet period (default 3 minutes, `ULP_MOVER_QUIET_MIN`), a guard against the instant between the client closing the file and recording it;
   - no part of the file is missing: fewer blocks on disk than bytes means a hole, which only an interrupted download has. The filesystem is ext4 without compression, so blocks are a reliable measure here.
   The open-file scan runs again right before the move, and the size and modification time are compared with what was hashed; a file that changed or reopened in between stays.
2. **One owner of the download folder.** The mover (`scripts/pull-downloads.ts`, `lib/stand-in-sweep.ts` with an inbox) does both things the ledger decides: a new finished file is MOVED into the inbox (a rename on one filesystem) and a stand-in takes its place; a file whose bytes are ingested and held by the archive is swapped for a stand-in (the archive entry is decoded again first). Ingested but not archived, or known by name and size without a hash, stays as it is. A name already in the inbox or one of its folders is refused and reported. The archive timer no longer sweeps; it refreshes the ledger copy, and once more after it archived something.
3. **A minute timer, not events.** `scripts/systemd/ulp-pull-downloads.timer` runs the oneshot service every minute (one run at a time, plus a lock file for a run by hand). A download becomes eligible about four minutes after its last write (quiet period plus the next tick). Polling needs no daemon and each run is the same code path the tests exercise; an inotify close-write trigger would save about a minute and add a process to keep alive.
4. **Scope.** `*.txt` of 1 MB or more, one level deep (`--ext`, `--min-size`). Smaller text files in the folder (lists and notes, up to 100 KB there) and other types stay put.
5. **No move while stalled is not detectable.** A paused or stalled download keeps the file open in the client, so the first gate covers it. The one gap is a client killed mid-download; the hole check catches most of those (the client writes parts in parallel), and what it misses is a short file that gets imported as it is: no row is lost, and the complete file, downloaded later under another name, is imported on top of it with the novelty check dropping the repeats.

## The folders

```
~/Downloads/AyuGram Desktop/   the client saves here; finished .txt files leave a stand-in behind
~/Desktop/ulp-suite/inbox/     the mover drops finished files here; the importer takes them (done/ held/ failed/ processing/ as before)
~/Desktop/ulp-archive/         the compressed, verified copy of every imported file
~/Desktop/ulp-pipeline/        STATUS.html  STATUS.txt  README.txt  ledger.tsv  stand-ins.tsv  hashes.json  last-run.json
~/Desktop/ULP-STATUS.html      a link to the status page
```

The ledger copy, the stand-in registry and the hash cache moved from loose files on the desktop into `ulp-pipeline/` (`ULP_PIPELINE_DIR`, `ULP_LEDGER_FILE`); nothing was deleted. The archive keeps its place (its path is in the timer units and the compose file).

## The status page

`lib/pipeline-status.ts`: `gatherFacts` reads the machine (both timers through `systemctl --user`, the two containers through `docker ps`, the inbox folders, the job log read-only, the archive status file, the ledger copy, the stand-in registry checked against the disk, free disk), `evaluate` gives each stage a verdict, and the banner is the worst of them. Green: "Fully working". Amber: it works and something needs the owner (a held file, an interrupted download, a stand-in that no longer matches its record, the ledger copy older than two hours, free disk under 140.52 GiB). Red: something is broken (a timer stopped or silent for 10 minutes, a run that failed, an unhealthy container, a failed file, no ledger copy, free disk under 50 GiB, the disk gates the pipeline already has). Downloads in progress are normal and shown green with the reason each is waiting. The page also names the last file that went the whole way (moved, imported, archived). The mover rewrites the pages on every run; they are written through a temp name and a rename.

## Proof

- **Tests.** 35 new: the open-file scan against a real second process that holds a file open and against a fake `/proc`; every gate; the move (stand-in with the same size and nanosecond time and no blocks, registry line, dry run, refused name, swap versus keep, the reopen and the growth between hash and move); the whole case with a real process that keeps writing, is not moved, and arrives whole after it closes; the mover command in a sandbox (lock, off switch, missing folders, status pages); the verdicts and the pages (including a file name that cannot inject markup). Full suite 5,208 passed, typecheck and lint clean.
- **On the real machine, unattended, with a synthetic file** (a list of numbers, so no credential could be added): a process held a file open and wrote to it; the minute timer, under systemd, reported it as "still open in another program (pid …)" and left it. A second file written the same way (last write 12:36:45, closed about 12:37:25) was reported "settling" at the next tick and had moved by 12:40:51, about 4 minutes after its last write (the quiet period of 3 minutes plus the tick), with a stand-in of the same size and zero blocks left behind; the importer took it from the inbox. The quality gate then held it (100% of its lines have no login and password), which is the correct result for a numbers-only list; the held copy, its stand-in and its registry line were removed by hand, and the other test file was deleted before it could move. The earlier 24 real downloads had gone through the same hand-run steps (move, import, archive, stand-in) before the timer existed.

## Not done

- **The first real download in the client.** Its behaviour is from the upstream source plus the descriptors seen on this machine; the page shows "still open (pid …)" for a real download, and that is the acceptance test.
- **A card in the app's Inbox page.** The app container cannot see the download folder, the timers or the stand-ins, so the page is a file on the desktop; showing it in the app would need the mover to publish a summary into a folder the container mounts (the archive status file already does this) and a deploy.
- **History in the client.** Files moved before stand-ins existed lost their record at the next client start; only a patched client reading the ledger could mark those.
- **Other file types** (archives such as zip or rar) and text files under 1 MB.
