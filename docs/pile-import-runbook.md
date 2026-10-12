# Pile import runbook

How a batch of Telegram downloads (or the whole pile) is imported, verified and, for a parser change, redone. Written for the redo of 2026-10-12
(design: `docs/superpowers/specs/2026-10-12-parser-v6-and-redo-design.md`). The repository is public: never put source file names, search terms or credential
values into a log, a commit or a doc.

## The scripts (`scripts/pile/`)

| Script | What it does |
|---|---|
| `feed.sh` | Hardlinks the pile's `.txt` files into `./inbox` smallest-first, two in flight; pauses under `FLOOR_GIB`, stops on a new file in `inbox/failed`. `DRY_RUN=1` prints the queue and stops. Never touches an original. |
| `reset.sh` | `check` (read-only) or `apply`: drop the partition the run filled, delete the pile's `ulp.sources` rows, unlink `inbox/done` names that are hardlinks of originals. Aborts while a file is in flight. |
| `watch.sh` | One monitor for a run (feeder events, anomalies, a heartbeat). Run it under the Monitor tool. |
| `global-checks.sh` | Read-only checks of the run's partition (duplicates, junk signature, `t.me/`, double-encoded text, empty fields, hash collisions with the older partitions). |
| `jobs-summary.cjs` | One line (or one per job) from a COPY of `data/ulp.db`: files done / failed, rows new / known / skipped. |
| `verify-file.ts` | Per-file exact recount: re-parses the original with the app's own parser and policy and compares with the job record and ClickHouse. |

Environment: `ULP_REPO` (the checkout whose `./inbox` and `./data` are used; default: the checkout the script is in, so from a worktree set it to the primary
checkout), `PILE_DIR` (default `$HOME/Downloads/AyuGram Desktop`), `PILE_WORK_DIR` (default `<repo>/.pile-work`, git-ignored), `CH_CONTAINER`
(`ulpsuite_clickhouse`), `PARTITION` (`202610`, the partition the run fills), `FLOOR_GIB` (60), `IN_FLIGHT` (2). A script that was started from a worktree of the
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
   goes into the image changed after the commit it was built from (8c79c1c for `v6-candidate`):
   `git diff --stat 8c79c1c..<main sha> -- app lib components public Dockerfile docker-entrypoint.sh package.json package-lock.json next.config.mjs tsconfig.json`
   must print nothing; then `docker tag ulp-suite-app:v6-candidate ulp-suite-app:latest`. Otherwise build from the merged commit, not from a worktree:
   `git archive <sha> | tar -x -C /tmp/build-<sha>`, then `DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker build -t ulp-suite-app:latest /tmp/build-<sha>`, and run the alert
   rehearsal and the novelty `v6` scenario on that image before using it.
3. Nothing in `inbox/processing`. Recreate only the app **with the compose file of the merged commit**, anchored to the primary checkout's environment (from a
   worktree plain `docker compose` would blank the secrets and serve an empty database). The primary checkout may still be on an older branch whose
   `docker-compose.yml` does not forward `INGEST_FILTER_HARD_KEEP_COUNTRIES`: the new image would then run with an EMPTY keep-list and drop every T3 line again, so do
   not run compose from there. The running stack is project `ulp-suite` (working dir `/home/cole/ulp-suite`):
   `cd <checkout at the merged commit> && DOCKER_CONFIG=/tmp/claude-1000/dockercfg docker compose -p ulp-suite -f docker-compose.yml --project-directory /home/cole/ulp-suite --env-file /home/cole/ulp-suite/.env up -d --no-deps app`
   (`git diff <the primary checkout's HEAD> <main sha> -- docker-compose.yml` shows what changes: the keep-list variable on the app and two backup booleans). Never `build` from here.
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
2. `npx tsx scripts/pile/verify-file.ts <db copy dir> '<CUT>' <file> ...` on a spread of 5-10 files (small, 100 MB, 1 GB, one of the largest): every check `ok`.
3. Build the search dictionary by hand: `npx tsx scripts/build-search-dictionary.ts --skip-headroom-check` (about 2.5 minutes, +2.2 GiB), then `--status` says fresh.
4. Cron lines after 05:00Z: `docker logs ulpsuite_app | grep -E "content-dedup\] cron|projection-scope\] cron"`; the dedup report must say `applied` false.
5. Side copy: `nice -n 19 npx tsx scripts/extract-dropped-lines.ts --src "$HOME/Downloads/AyuGram Desktop" --out <dir with 10 GiB free> --workers 8`; compare the manifest
   totals with the importer's `skipped`.
6. Only then may the OWNER delete or move the originals (nobody else does), and the rollback images may be pruned one tag at a time (`docker rmi <tag>`; never an
   unscoped prune: the daemon is shared with another project).

## Rollback

`docker tag ulp-suite-app:rollback-<...> ulp-suite-app:latest`, `docker compose ... up -d --no-deps app` (as in Switchover step 3), `CUT=... scripts/pile/reset.sh apply`,
re-import with the old parser. The older partitions are never touched.
