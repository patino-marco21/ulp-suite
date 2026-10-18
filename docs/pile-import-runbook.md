# Pile import runbook

How a batch of Telegram downloads (or the whole pile) is imported, verified and, for a parser change, redone. Written for the redo of 2026-10-12
(design: `docs/superpowers/specs/2026-10-12-parser-v6-and-redo-design.md`). The repository is public: never put source file names, search terms or credential
values into a log, a commit or a doc.

## The scripts (`scripts/pile/`)

| Script | What it does |
|---|---|
| `feed.sh` | Hardlinks the pile's `.txt` files into `./inbox` smallest-first, two in flight; pauses under `FLOOR_GIB`, stops on a new file in `inbox/failed`. `DRY_RUN=1` prints the queue and stops. Never touches an original. `SOURCE=archive` writes `.archiveref` files from the source archive instead (no original needed). `PREFLIGHT=1` skips a file the offline preflight says the quality gate would hold. A file the app holds (`inbox/held/`) is logged once as `HELD`; the run goes on. |
| `reset.sh` | `check` (read-only) or `apply`: drop the partition the run filled, delete the pile's `ulp.sources` rows, unlink `inbox/done` names that are hardlinks of originals. Aborts while a file is in flight. |
| `watch.sh` | One monitor for a run (feeder events, anomalies, a heartbeat). Run it under the Monitor tool. |
| `global-checks.sh` | Read-only checks of the run's partition (duplicates, junk signature, `t.me/`, double-encoded text, empty fields, hash collisions with the older partitions). |
| `jobs-summary.cjs` | One line (or one per job) from a COPY of `data/ulp.db`: files done / failed, rows new / known / skipped, and where the time went (`parse` = waiting for the parser, `check` = the existence check, `insert` = stage inserts plus the commit insert) once the database has `processing_jobs.parse_ms` / `check_ms` / `insert_ms`. |
| `verify-file.ts` | Per-file exact recount: re-parses the original with the app's own parser and policy and compares with the job record and ClickHouse. |
| `scripts/archive-queue.cjs` | The feeder's helper for `SOURCE=archive`: `list <archive dir>` and `write <archive dir> <name> <dest>`. |

Environment: `ULP_REPO` (the checkout whose `./inbox` and `./data` are used; default: the checkout the script is in, so from a worktree set it to the primary
checkout), `PILE_DIR` (default `$HOME/Downloads/AyuGram Desktop`), `PILE_WORK_DIR` (default `<repo>/.pile-work`, git-ignored), `CH_CONTAINER`
(`ulpsuite_clickhouse`), `PARTITION` (`202610`, the partition the run fills), `FLOOR_GIB` (60), `IN_FLIGHT` (2), `SOURCE` (`files`; `archive` feeds from the source archive in `ULP_ARCHIVE_DIR`, default `~/ulp-archive`), `PREFLIGHT` (0),
`PREFLIGHT_CMD` (`npx tsx scripts/preflight.ts --quiet`, run from the checkout the script is in). A script that was started from a worktree of the
repository writes its scratch files under `PILE_WORK_DIR`: point that at a scratch directory so the primary checkout stays clean.

## Preconditions of a redo

1. The previous run is COMPLETE: the feeder log has a `COMPLETE` line, `inbox/` has no top-level file and nothing in `processing/`, `inbox/failed/` holds only the old
   `.08` file (a failed file from before the run).
2. Its global checks are recorded: `CUT='<first import time of that run>' QUICK=1 scripts/pile/global-checks.sh`.
3. The candidate image passed the gate and every rehearsal, **including the two disk-filling ones** (`e2e-disk-gate.ts`, novelty `gate`), which run only after
   the run has finished because they write tens of GiB of filler to the same disk; CI is green on `main`.
4. The owner said go and was told the time of the ~30 s restart.
5. Free disk after the drop is expected to be about 140 GiB; the levers are: defer the 12 largest files (pre-authorized); remove the stopped Strix containers
   ONLY after the owner confirms again and after looking at what is in them. Unlinking `inbox/done` names frees nothing while the originals exist.

## Switchover

1. Tag the running image BEFORE anything else (the containerd image store garbage-collects an image whose tag moves):
   `docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" ulp-suite-app:rollback-<yyyymmdd>-<hhmm>z`.
2. The image: the tested candidate is the best choice, because the bits that were rehearsed are the bits that are deployed. It is valid only while nothing that
   goes into the image changed after the commit it was built from (e20feb4, parser v6.1, for `v6-candidate`; the earlier candidate without the pipe and semicolon rules is `v6-candidate-prepipe`, built from 8c79c1c):
   `git diff --stat e20feb4..<main sha> -- app lib components public Dockerfile docker-entrypoint.sh package.json package-lock.json next.config.mjs tsconfig.json`
   must print nothing; then `docker tag ulp-suite-app:v6-candidate ulp-suite-app:latest`. Otherwise build from the merged commit, not from a worktree:
   `git archive <sha> | tar -x -C /tmp/build-<sha>`, then `DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker build -t ulp-suite-app:latest /tmp/build-<sha>`, and run the alert
   rehearsal and the novelty `v6` scenario on that image before using it.
3. Nothing in `inbox/processing`. Recreate only the app **with the compose file of the merged commit**, anchored to the primary checkout's environment (from a
   worktree plain `docker compose` would blank the secrets and serve an empty database). The primary checkout may still be on an older branch whose
   `docker-compose.yml` does not forward `INGEST_FILTER_HARD_KEEP_COUNTRIES`: the new image would then run with an EMPTY keep-list and drop every T3 line again, so do
   not run compose from there. The running stack is project `ulp-suite` (working dir `/home/cole/ulp-suite`):
   `cd <checkout at the merged commit> && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose -p ulp-suite -f docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app`
   (`git diff <the primary checkout's HEAD> <main sha> -- docker-compose.yml` shows what changes: the keep-list variable on the app and two backup booleans). Never `build` from here.
   Rehearse it first, it changes nothing: the same command with `config | grep -E 'INGEST_FILTER|CONTENT_DEDUP_APPLY'` must show `HARD_DROP_TIERS: T3`, the 15 countries and
   `CONTENT_DEDUP_APPLY: "false"` (do not print the whole config: it holds the secrets), and with `--dry-run up -d --no-deps app` it prints `Container ulpsuite_app Recreate`
   (checked on 2026-10-12: the live container kept its start time and image).
4. Verify: `docker inspect ulpsuite_app --format '{{.State.Health.Status}} {{.RestartCount}}'` is `healthy 0`;
   `docker exec ulpsuite_app printenv | grep -E 'INGEST_FILTER|CONTENT_DEDUP_APPLY'` shows `HARD_DROP_TIERS=T3`, the 15-country `HARD_KEEP_COUNTRIES` and
   `CONTENT_DEDUP_APPLY=false`; the log has no error; the login page answers.
5. Reset (read the check first): `CUT='<first import time of the run being replaced>' scripts/pile/reset.sh check`, then
   `CUT=... ALL_PILE_NAMES=1 scripts/pile/reset.sh apply` (`ALL_PILE_NAMES=1` also removes the `ulp.sources` rows of pile files imported long ago, which would
   otherwise pass the same-name guard).
6. Start the feeder detached and its monitor: `nohup scripts/pile/feed.sh >> <log> 2>&1 &` and `START_TS=... FEED_LOG=<log> scripts/pile/watch.sh` under the
   Monitor tool (30-minute cap: re-arm it).

## During the run

- The feeder pauses itself under `FLOOR_GIB` and resumes at +5; the app's own gate pauses at 50 GiB. A failed file stops the feeding: read
  `processing_jobs.error_message` (`node scripts/pile/jobs-summary.cjs <db copy> <since> list`), then `mv inbox/failed/<name> inbox/<name>` to retry (exactly once, by content).
- Merged-away parts stay on disk for 8 minutes: free space dips 5-20 GiB below its steady level in waves.
- Do not deploy, restart the app or run a heavy query against `ulp.credentials` meanwhile; never write `IN (SELECT ... FROM ulp.credentials)` (the small set goes
  in the subquery, the big table is only filtered by it).

## After the run

1. `CUT=... scripts/pile/global-checks.sh` (all lines): 0 duplicate hashes, junk signature about 500 per million, `t.me/` about 3 per million, double-encoded text about 0,
   0 empty fields, 0 hash collisions in the 4 buckets.
2. `npx tsx scripts/pile/verify-file.ts <db copy dir> '<CUT>' <file> ...` on a spread of 5-10 files (small, 100 MB, 1 GB, one of the largest 4 GB ones, which takes ~8 minutes and 2 GB of memory): every check `ok`. It parses the file with the
   working tree's parser, so run it from a checkout of the commit that is deployed; against rows imported by an older parser it reports FAILs by design.
3. Build the search dictionary by hand: `npx tsx scripts/build-search-dictionary.ts --skip-headroom-check` (about 4 minutes, +2.5 GiB; run 4's took 237 s), then `--status` says fresh.
4. Cron lines after 05:00Z: `docker logs ulpsuite_app | grep -E "content-dedup\] cron|projection-scope\] cron"`; the dedup report must say `applied` false.
5. Archive the pile (the archive holds everything the old side copy of the dropped lines held, and the stored lines too): `mkdir -p ~/ulp-archive` once, then
   `nice -n 19 npx tsx scripts/archive-sources.ts archive --src "$HOME/Downloads/AyuGram Desktop" --workers 8` (about 17 minutes plus 2 of verification on an idle
   machine; it needs 10 GiB plus twice the largest file free, and it never runs while a pile run is writing to the same disk). `status` shows the names, the
   compression ratio and the `ulp.sources` rows that have no archive; `verify --all` decodes everything again. Nothing is removed by this step. Before importing a new batch run `scripts/preflight.ts` on it (see The quality gate).
6. Only then may the OWNER run the same command with `--replace`: each original, and the `inbox/done` names that are hardlinks of it, is removed only after its archive
   was decoded again and matched, and never while a file is in flight in the inbox (see "The source archive" below). The rollback images may be pruned one tag at a
   time (`docker rmi <tag>`; never an unscoped prune: the daemon is shared with another project).

## The source archive

`scripts/archive-sources.ts` keeps every source file as a verified zstd archive in `~/ulp-archive` (`ULP_ARCHIVE_DIR`; the directory must exist, the tool never creates it).
It is outside the repository and the Docker build context, and `manifest.jsonl` holds file names, so it is never committed. The archive lives on the same disk as
everything else: it protects against a parser or policy change, not against losing the disk (copy the directory to an external drive for that).

| Command | What it does |
|---|---|
| `archive --src <dir> [--workers 8] [--only a,b] [--dry-run]` | archive every `.txt`, verify each archive by decoding it again, record it in `manifest.jsonl`, then fill the identity columns of `ulp.sources` (`--no-sources` skips that) |
| `archive ... --replace [--include-unimported]` | also remove the original and its hardlinks under `inbox/done`, after confirming the archive against the original again |
| `status` | names, replaced, compression ratio, `ulp.sources` rows without an archive |
| `verify [--all \| --sample 3]` | decode archives again and compare with the manifest |
| `restore <name\|id> --to <path>` | write the original bytes back (never overwrites; checks the sha256) |
| `sources-sync` | (re)apply the `ulp.sources` identity columns for the archived names |

`--replace` keeps an original (and says why) while a file is in flight in the inbox, when the file was modified in the last 10 minutes, or when the name is not in
`ulp.sources` yet. `scripts/parser-diff.ts`, `scripts/pile/verify-file.ts` and `scripts/extract-dropped-lines.ts` read an archived name exactly like a file, so they keep
working after `--replace`. For a new batch: archive it first (without `--replace`), import, verify, and replace when you decide.

## The quality gate

The importer counts, while it stages a file, the rows that break a rule a correctly parsed row never breaks and the lines it could not split (`lib/ingest-quality-gate.ts`;
design in `docs/superpowers/specs/2026-10-12-source-archive-and-ingest-gate-design.md`). A file is **held** before one row is stored when at least 20,000 lines were read and
more than 2% of the stored rows break a rule, more than 5% of the lines were unsplit, or more than 25% are garbage; it is checked once after the first million lines (a bad 4 GB
file costs a million lines, not the file) and once before the commit. A held file moves to `inbox/held/`, the job is logged as `held` with its report, the Inbox page lists it
with the reasons, the counts, the kinds and the masked shapes (no text of the file), and Ingest Health shows how many are held.

- **Read the reasons first.** A hold usually means the parser mis-reads a layout, not that the file is bad. Fix the parser and drop the file in again (move it from `inbox/held/` to `inbox/`; the next claim is gated again), or
- **Release** it on the Inbox page when the file is what you want: it is imported once, the gate reports but does not hold it, and the audit log gets an `inbox.release` row.
- `INGEST_QUALITY_GATE=warn` only reports; `off` switches it off (the Rollback of the gate release). A held file is never deleted by the app; delete it by hand when you do not want it.
- **Before a batch:** `npx tsx scripts/preflight.ts <file or archived name>...` reads a sample (5 slices of 2 MiB; the whole file when it is at most 8 MiB) through the same parser and counters
  and prints PASS / WARN / HOLD per file with the numbers, the kinds, the masked shapes of the rows that break a rule and of the lines no field split could read. Exit 1 when a file would be held.
  `PREFLIGHT=1` makes the feeder do this for every file and skip (log `SKIP`) what would be held. Reading the whole pile takes about two minutes with four low-priority workers.
- A ZIP entry that is held holds the whole archive (the entries before it stay imported; a Release re-imports the ZIP and the recorded entries are skipped by name).

### Importing from the archive

After `archive-sources ... --replace` there is no original to link. `SOURCE=archive scripts/pile/feed.sh` writes one `<name>.archiveref` per archived name into `./inbox` (the file is a few hundred
bytes: id, name, size, sha256); the importer decodes the plaintext from `~/ulp-archive` (mounted read-only into the app at `/archive`), hashes it on the way to the parser and fails the job
before the commit when the sha256 differs. `ulp.sources` records the original name with its size, sha256 and archive id; a file with the same name and another content is a new file, the same
name and content stays blocked. No plaintext copy is made: `inbox/done` keeps only the references.

### Deploy checklist of the gate release (one app deploy, after a pile run is complete and its checks are recorded)

1. Nothing in `inbox/` or `inbox/processing/`; tag the running image first (`docker tag "$(docker inspect ulpsuite_app --format '{{.Image}}')" ulp-suite-app:rollback-<yyyymmdd>-<hhmm>z`).
2. `test -d ~/ulp-archive || mkdir ~/ulp-archive` **as the owner, before `compose up`**: the compose file mounts it, and Docker creates a missing host directory owned by root.
3. Build from the merged commit with `git archive` (as in Switchover step 2), run the rehearsals on the isolated stack: alert, upload-resilience, novelty (`--only=quality-gate,archive-ref` plus the full run), and the disk-filling ones.
4. Recreate only the app with the compose file of the merged commit, anchored to the primary checkout's environment (Switchover step 3). The log must say `DDL v28 applied`; `docker exec ulpsuite_app ls /archive` lists the archive.
5. Verify: `healthy 0`; the Inbox page shows no Held card; `npx tsx scripts/archive-sources.ts status` reports the names without an archive row; `sources-sync` fills the identity columns.
6. Rollback: `INGEST_QUALITY_GATE=off` in `.env` and recreate the app, or the rollback image tag. DDL v28 is additive and stays.

## Rollback

`docker tag ulp-suite-app:rollback-<...> ulp-suite-app:latest`, `docker compose ... up -d --no-deps app` (as in Switchover step 3), `CUT=... scripts/pile/reset.sh apply`,
re-import with the old parser. The older partitions are never touched.
