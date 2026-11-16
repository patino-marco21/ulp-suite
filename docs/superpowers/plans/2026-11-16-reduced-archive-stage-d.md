# Reduced archive, stage D (swap the old whole-file entries for their reduced entries) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the archive keep the reduced entry of a file instead of its whole entry, for the old files (stage D), without breaking anything that reads the archive: the replace gate, `verify`, `restore`, the stand-in sweep, the re-feed and the importer's archive reference. Nothing in the live archive is touched by this plan; the one command that removes a whole entry (`reduce-archive.ts swap --apply`) is run by hand, on the owner's separate yes, after the report.

**Architecture:** A swap appends one line to the main `manifest.jsonl` (the old entry plus `reduced_id` and `whole_removed_at`; `latestByName` already lets a later line supersede an earlier one) and then removes `<id>.zst`. Every reader asks one question of the entry, `isSwapped(entry)`, and either follows `reduced_id` into `reduced/manifest.jsonl` or refuses with a message that names the reason. No reader changes behaviour for an entry that has no `whole_removed_at`.

**Tech Stack:** TypeScript, vitest, `lib/source-archive.ts`, `lib/reduced-archive.ts`, the isolated stack of `docker-compose.rehearsal.yml` for the end-to-end check.

## Global Constraints

- Owner decisions (2026-11-16): keep-once for lines only the 199 pre-archive sources hold; accept that the archive no longer holds byte-identical originals (the exact original stays only in the chat service); swap every exact entry that saves 10% or more of its bytes on disk; the 8 files with a line over 1 MiB stay whole; staged cut (about 20 files, a real restore and re-feed test, a day's wait, then the rest in batches with `verify` after each); the report must show all entries exact, at least 100 GiB freed and a proven restore before the owner is even asked for the cut yes.
- The one removing command is `swap`, a dry run unless `--apply`, and it never runs unattended: no timer calls it.
- A swap is crash safe in this order: verify the reduced entry, append the manifest line (fsync), only then unlink the whole file. A crash between the two leaves an orphan `<id>.zst` that the next run removes; a swapped entry is never left pointing at a missing reduced entry.
- A reader that needs the original bytes refuses a swapped entry (`restore`, the stand-in restore, `openSource`); it never hands out reduced text as if it were the original.
- Behaviour with no swapped entry is unchanged (pinned by tests that run every changed reader on a manifest without one).
- Public repo: committed text carries numbers and reasons only; tests use invented data.
- ClickHouse and importer behaviour is proven on the isolated rehearsal stack (`scripts/e2e-reduced-archive.ts`), not by mocks alone. A change to `lib/upload-processor.ts` ends with the app rehearsal, a rollback tag, a candidate image and a local deploy.

## File Structure

- Modify `lib/source-archive.ts`: `ManifestEntry` gets optional `reduced_id` and `whole_removed_at`; `openSource` refuses a swapped name unless asked for the reduced entry.
- Create `lib/archive-swap.ts`: `isSwapped`, `reducedFor`, `swapCandidates` (the Q9 rule), `swapOne` (the safe order), `swapReport` (the numbers of the report and its go/no-go lines).
- Modify `scripts/reduce-archive.ts`: `report` and `swap` commands.
- Modify `lib/archive-auto.ts` (`readyToReplace`): a swapped name is its own bucket, neither ready nor unarchived.
- Modify `scripts/archive-sources.ts`: `status` counts swapped names, `verify` checks the reduced entry for them, `restore` refuses with the reason (and `--reduced` writes the reduced text, labelled).
- Modify `lib/stand-in-sweep.ts`, `scripts/stand-in-sweep.ts`, `scripts/pull-downloads.ts`: `holds` and `verify` follow `reduced_id`; `restoreStandIn` refuses a swapped entry.
- Modify `lib/refeed-plan.ts`, `lib/archive-ref.ts`, `lib/upload-processor.ts`: an archive reference may carry `of` (the original's sha256 and size); the importer checks the stream against the reduced sha256 and records the original's identity in `ulp.sources`.
- Modify `scripts/e2e-reduced-archive.ts`: swap, restore refusal, stand-in, re-feed from a reduced entry.
- Create the tests named per task; modify `docs/superpowers/specs/2026-11-15-reduced-archive-design.md` (stage D section) and `docs/superpowers/specs/2026-10-01-newest-first-windows-design.md` (the rejected offset-only projection, numbers only).

## Task 1: the swap core (`lib/archive-swap.ts`)

**Interfaces:**
- `isSwapped(e: ManifestEntry): boolean` is `e.whole_removed_at !== undefined`.
- `reducedFor(archiveDir, e): ReducedEntry | undefined` follows `e.reduced_id` in `reduced/manifest.jsonl` and returns it only when `of.sha256 === e.sha256` and `of.size === e.size`.
- `swapCandidates({ wholes, reduced, log, wholeOnDisk, minSavingPct = 10 })` returns `{ eligible: SwapItem[]; left: Record<LeftReason, number> }`; `SwapItem` is `{ whole, reduced, savedBytes }` with `savedBytes = whole.archive_bytes - reduced.archive_bytes`. `LeftReason` is `already-swapped | no-whole-file | no-reduced | long-line | not-exact | below-threshold`. `not-exact` is the latest shadow-log line of the (name, sha256) being a failure other than the long-line skip.
- `swapOne({ archiveDir, item, now })` returns `{ ok: true, freedBytes } | { ok: false, reason }` and does the three steps in the order of the constraints. It is idempotent: a swapped entry returns `ok` with 0 bytes.

**Tests (`__tests__/archive-swap.test.ts`, real tiny archives built with `archiveFile`):** eligible entry swaps and frees the whole file's bytes; an entry below 10% stays; the long-line name stays; a failed latest log line stays; a reduced entry whose `of` differs from the whole is refused; a damaged reduced file is refused before anything is removed; a crash after the manifest append (unlink skipped) leaves a manifest the readers accept and `swapOne` run again removes the orphan; running `swapOne` twice is a no-op.

## Task 2: `report` and `swap` commands (`scripts/reduce-archive.ts`, `lib/archive-swap.ts`)

`report` prints, in numbers only: names, reduced entries, eligible, left by reason, bytes on disk freed by the eligible set, the projected free space after, drift (files and stored keys), and the three go/no-go lines of the owner's bar (all eligible entries pass `verifyEntry` on both sides; freed at least 100 GiB; the restore proof is a line the e2e run prints and the owner is shown). `swap` takes `--limit N`, `--only`, `--apply`, `--batch-gib`; without `--apply` it prints what it would do; with it, it stops at the first failure and runs `verify` over the batch it swapped. Tests: the report arithmetic on invented manifests, the dry run touches nothing, `--apply` stops at the first failure.

## Task 3: readers that must not misread a swapped entry

`readyToReplace`: a swapped name is counted in a new `swapped_files` field and in neither `ready_files` nor `unarchived_files` (so `keep-awake` and `archive-when-idle` never try to archive it again). `archive-sources status` shows swapped names; `verify` verifies the reduced entry of a swapped name instead of the missing whole file; `restore` refuses a swapped name with a message that says the original is not in the archive and where the reduced text can be had; `openSource` refuses a swapped name unless called with the reduced option (the analysis tools get a clear error, not skewed text). Tests: each reader on a manifest without a swapped entry gives the old answer; on one with it gives the new one.

## Task 4: the stand-in gate

A download whose sha256 the ledger knows as ingested and whose original a swapped entry stands for is swapped for a stand-in when the reduced entry verifies and its `of.sha256` equals the download's hash (identity by hash, not by decoding the archive). `restoreStandIn` refuses a swapped entry. Tests in `__tests__/stand-in-sweep.test.ts` style: a swapped entry lets the sweep make a stand-in; a reduced entry that does not verify blocks it; restore refuses.

## Task 5: re-feed from a reduced entry

`ArchiveRef` gets optional `of: { sha256, size }`; `serializeArchiveRef` and `parseArchiveRef` carry it (a reference without it parses as before). `planRefeeds` builds the reference of a swapped name from its reduced entry. `processArchiveRef` accepts a reference to a reduced entry, checks the stream against the reduced sha256 before the commit, and writes the original's size and sha256 into `ulp.sources` (so the file ledger and the same-bytes skip keep working). Tests: parse round trip, plan item for a swapped name, the importer test of `upload-processor-archive-ref.test.ts` with a reduced entry, a damaged reduced entry fails before the commit.

## Task 6: end to end, docs, deploy

`scripts/e2e-reduced-archive.ts` gets a stage D scenario on the isolated stack: build a whole and a reduced entry, swap, `verify`, `restore` refusal, stand-in, re-feed from the reduced entry and the rows it adds. Docs: the stage D section in the design spec, the offset-only projection note in the newest-first spec. Merge to main and push once CI is green. The app image is rebuilt and deployed (rollback tag first) because `lib/upload-processor.ts` changed; the timers pick up the host-side scripts from the primary checkout by themselves, and none of it changes anything until a swap exists.
