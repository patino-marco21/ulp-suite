# Disk safety and hygiene — design (2026-10-11)

Status: **approved 2026-10-11, not implemented.** Sub-project 1 of the 2026-10-11 plan. Sub-project 2 is
`2026-10-02-novelty-aware-ingest-design.md` (it waits for this one). Reference machine: one 937 GiB disk shared by the OS, Docker and the ClickHouse
volume (about 515 GiB: `ulp.credentials` 128.88 GiB, the archive `credentials_predup_auto` 381.20 GiB, the two search dictionaries 2.1 GiB).
Every number below was measured read-only on 2026-10-10/11. The operator's own search terms, file names and channel names are deliberately absent
(the repository is public).

## The problem: five days of a full disk, and nothing in the product said so

Free space went from 167 GiB (2026-10-05) to 0.00 GiB (2026-10-09, ClickHouse's `DiskAvailable_default`). The causes were outside the product: a
113.6 GiB `/var/log/syslog` (a desktop application's GPU-process failure loop) and 140 GiB of downloads waiting to be imported. What the product
did, and failed to do:

1. **The ingest path has no disk gate.** The only check before an insert batch is `waitForHeadroom` (`lib/clickhouse-memory-guard.ts`): ClickHouse
   *memory* pressure, fail-open. The disk guard (`lib/clickhouse-disk-guard.ts`) is used only by the dedup populate, the projection restore and the
   search dictionary. Importing the pending 140 GiB as it is would have refilled the disk. (The HTTP spool checks a 20 GiB floor on its own directory,
   `lib/upload-spool.ts`; that protects the spool, not ClickHouse's volume.)
2. **Nobody was told.** `lib/disk-watch.ts` logged CRITICAL every 6 hours for five days, but the status is shown only in the Ingest Health panel on
   the Upload and Inbox pages, and `DISK_ALERT_WEBHOOK_URL` is unset. The operator logged in on 2026-10-09 with about 9 GiB free; no page except Upload and Inbox would have shown it.
3. **`projection-scope` turned a full disk into a wedged table.** `buildEligiblePartitionsSql` (`lib/projection-scope.ts:40`) selects every active
   partition older than the cutoff and not the newest, without asking whether any part still carries the projection. `proj_imported_desc` exists only
   in partition 202608 (2 parts, 33.14 GiB; `system.projection_parts`), so each daily `ALTER ... CLEAR PROJECTION ... IN PARTITION '202607'` was a
   pure no-op, yet a *replicated* ALTER: it bumps the table's metadata version (now 31) and creates a mutation whose merge-tree task reserves
   part size x 1.1 (64.5 GiB for the 58.64 GiB part) although it only hard-links. Below that much free space the mutation (ids 25 and 26) stayed
   postponed, the `ALTER_METADATA` entry for version 31 waited behind it ("another alter 30 must be executed before"), and the next ticks failed with
   code 517, a 60 s client timeout, and a Keeper timeout after a 14.8 h wait. When 113 GiB came back on 2026-10-11 the queue drained by itself within
   minutes. The replica had also recorded code 242 (read-only) at some point in the 0 GiB period; it was writable again afterwards.
4. **The crons do not run when they say they do.** `lib/dedup-cron.ts` and `lib/projection-scope-cron.ts` arm `setTimeout(first tick at the anchor
   hour)` and `setInterval(24 h)` at boot. The interval starts at boot, so after the first anchored tick both fire at the boot time of day
   (observed: 23:32:59Z on 10-06, 10-07, 10-08, 10-09 instead of 04:00Z and 05:00Z). The original reason for the anchor (`lib/dedup-cron.ts`
   header) was to keep heavy work out of the operator's working hours.
5. **CI and dependencies have a date on them.** `ubuntu-latest` migrates to Ubuntu 26 on 2026-10-19; `actions/checkout@v4` and `actions/setup-node@v4`
   are Node 20 actions forced onto Node 24; `npm audit` went from 0 to 12 findings (9 high, 3 moderate) between 2026-10-02 and 2026-10-10.
6. **Debris.** An orphan worktree, five placeholder images and a stylesheet nothing references, an untracked `.claude/launch.json`.

## Measurements (read-only, live)

| What | Result |
|---|---|
| Partitions carrying `proj_imported_desc` | 202608 only (2 parts, 33.14 GiB); 202607 has `proj_domain_rev` and `proj_email_domain_rev` only |
| Part sizes, 202607 / 202608 | 58.64 GiB, 2.03 GiB, 8.59 MiB / 68.06 GiB, 138.98 MiB |
| New eligibility query with cutoff 202608 and the newest-partition rule | 0 rows: no ALTER would be issued today |
| Same query without the newest-partition rule (join check) | 202608, 2 parts, largest parent part 73,079,089,152 bytes |
| Recovery | free 7.8 -> 121.5 GiB at 00:27Z; mutations 24-26 done at 00:27:34Z, replication queue 0, replica writable, no `text_log` errors |
| Observed cron times, `[content-dedup]` / `[projection-scope]` | 04:01:54Z and 05:00:00Z on 10-06 (anchored), then 23:32:59Z / 23:33:00Z daily (boot-relative) |
| `npm audit` | `next` GHSA-4jqv-mc3x-m676 (SSG/ISR cache poisoning), `sharp` GHSA-wq5f-xc86-pv6w, `source-map-js` GHSA-68fv-2mgg-jv7q, `postcss-nested`: non-major fixes exist. `braces`, `micromatch`, `fast-glob`, `chokidar`, `postcss-selector-parser` via `tailwindcss` and `eslint-config-next` (dev tooling) need major bumps |
| Current action majors | `actions/checkout` v7.0.1 (2026-07-20), `actions/setup-node` v7.1.0 (2026-10-08); both `using: node24` |

## Goals

1. An import can never be the thing that fills the disk: it pauses, visibly, and resumes by itself.
2. The operator sees a low disk on every page without opening a panel.
3. The projection-scope job can no longer issue a no-op ALTER, and cannot start an ALTER it cannot afford.
4. Both crons fire at their anchor hour every day.
5. CI survives 2026-10-19; the fixable audit findings are fixed; the debris is gone.

Not goals: see "Deliberately NOT done".

## Design

### 1. Ingest disk gate — `lib/ingest-disk-gate.ts` (new)

```ts
export interface IngestDiskGateState {
  enabled: boolean; paused: boolean; since: number | null; waiters: number
  freeBytes: number | null; floorBytes: number; resumeBytes: number
  checkedAt: number | null; error?: string
}
export function ingestDiskGateConfig(env?: NodeJS.ProcessEnv): { enabled: boolean; floorBytes: number; resumeBytes: number; pollMs: number }
export function waitForDiskSpace(signal: AbortSignal, opts?: { onPoll?: () => void; /* test seams: */ check?; sleep?; now?; env? }): Promise<void>
export function getIngestDiskGate(): IngestDiskGateState
```

- **Reading.** `checkDiskHeadroom()` (the `default` disk's `unreserved_space`, what ClickHouse itself can still reserve). A reading younger than 5 s is reused, so a batch every few seconds costs one tiny query.
- **Rule.** Proceed when free >= floor. Below the floor, pause: poll every 5 s, call `onPoll` on every poll (a waiting import is not a wedged one: the stall watchdog in `lib/import-runner.ts` is fed), `signal.throwIfAborted()` on every poll, and resume only when free >= `resumeBytes` = floor x 1.1 (no flapping).
- **Floor.** `INGEST_MIN_FREE_BYTES`, default 50 GiB (53,687,091,200). Not the dedup floor (140.5 GiB): that one protects a 129 GiB rewrite, this one protects the disk. 50 GiB (about 5% of the disk) leaves room for the merges of the newest partition, SQLite, the Docker daemon and logs. An unset, empty, non-numeric or negative value falls back to the default. `INGEST_DISK_GATE=off|0|false` turns the gate into a no-op (rollback without a rebuild).
- **No timeout.** A gate that fails the file after N hours leaves it partly imported, and until sub-project 2 a retry re-inserts the rows that already landed. The file waits; the operator frees space (or restarts the app, which fails the job through the existing paths).
- **Fail closed.** If the free-space read throws (ClickHouse unreachable), the state is `paused` with `error` set and a rate-limited log line; the inserts would fail anyway. This is the opposite of `waitForHeadroom` on purpose: that one is soft pacing, this one prevents the 2026-10-09 outcome.
- **Logs.** One line when it pauses (free, floor), one when it resumes (waited), a reminder every 10 minutes while paused.
- **State.** On `globalThis` (`__ulpIngestDiskGate`), like `lib/disk-watch.ts`: `instrumentation.ts` (the inbox watcher) and the route handlers are separate webpack chunks. `waiters` counts concurrent imports (`UPLOAD_CONCURRENCY=2`); `paused` is true while any waits.
- **Call sites.** (a) `streamCredentialsToTable` (`lib/upload-processor.ts`), once per batch immediately before `waitForHeadroom`, with `onPoll: options.onBeat`: HTTP uploads, the v1 API, ZIP entries and the inbox all pass through it. (b) `lib/inbox-watcher.ts`, inside the queued task right before `waitForHeadroom(guardController.signal)`, so a paused system does not even move a file from `inbox/` to `processing/`. Not in `scripts/` (repair and benchmark tools stay explicit).
- **Why per batch, not only per file.** A 3.9 GiB file is about 50M rows (about 5 GiB stored); a check only between files overshoots by a file, and the cost per batch is one cached query.

### 2. Disk banner

- `GET /api/monitoring/disk` (`app/api/monitoring/disk/route.ts`, `dynamic = 'force-dynamic'`): same auth as `ingest-health` (`validateRequest` + `requireAdminRole`). Returns `{ disk: await readDisk(), gate: getIngestDiskGate() }`. `app/api/monitoring/ingest-health/route.ts` also returns `ingestGate`, and `components/ingest-health-panel.tsx` shows a line "imports paused: waiting for disk space (X free, floor Y)" while it is set.
- `lib/disk-banner.ts` (pure): `describeDiskBanner(disk, gate): { level: 'warn' | 'critical' | 'paused'; message: string } | null`.
  - `gate.paused` -> `paused`: "Imports are paused: 48.2 GiB free, floor 50 GiB. They resume by themselves above 55 GiB."
  - else `disk.status === 'critical'` -> `critical`: "Disk critical: 121.5 GiB free of 936.8 GiB (13%). Dedup and projection jobs are blocked below 140.5 GiB; imports pause below 50 GiB."
  - A switched-off gate (`gate.enabled === false`) drops the "imports pause below ..." clause from the critical and warn messages: with `INGEST_DISK_GATE=off` nothing pauses, and the banner must not say it does (found when the banner was first seen rendered, on the rehearsal stack).
  - else `warn` -> `warn`: "Disk is getting low: 150.0 GiB free of 936.8 GiB (16%). Dedup and projection jobs stop below 140.5 GiB; imports pause below 50 GiB."
  - `ok` and `unknown` -> `null` (an unreadable disk already logs and shows in the panel; a permanent banner for a transient read error would teach the operator to ignore it).
- `components/disk-banner.tsx` (`"use client"`): fetches the endpoint on mount and every 60 s while `document.visibilityState === 'visible'`; renders nothing on 401, 403, a network error or `null`; `role="alert"` for `critical` and `paused`, `role="status"` for `warn`; amber/red classes from the existing theme tokens; a link "Ingest Health" to `/upload`. Rendered by `components/client-layout-with-sidebar.tsx` between `AppHeader` and `<main>`; the `/login` and `/check` branches return before it.
- Thresholds are unchanged (`lib/disk-watch.ts`). The banner will be red from the day it ships until free space passes 140.5 GiB, which on the reference machine means until the raw download pile is moved off the disk. That is accurate, not a defect.

### 3. `projection-scope`

- `buildEligiblePartitionsSql(cutoff)` becomes a query over `system.projection_parts` joined to the parent part (live-verified):
  ```sql
  SELECT pp.partition AS partition, count() AS parts_with_projection, max(pa.bytes_on_disk) AS largest_part_bytes
  FROM system.projection_parts AS pp
  INNER JOIN system.parts AS pa ON pa.database = pp.database AND pa.`table` = pp.`table` AND pa.name = pp.parent_name
  WHERE pp.database = 'ulp' AND pp.`table` = 'credentials' AND pp.name = 'proj_imported_desc' AND pp.active AND pa.active
    AND pp.partition < '<cutoff>'
    AND pp.partition < (SELECT max(partition) FROM system.parts WHERE database = 'ulp' AND `table` = 'credentials' AND active)
  GROUP BY pp.partition ORDER BY pp.partition
  ```
  The "never the newest partition" rule and the calendar cutoff are unchanged. Today the result is empty, so the daily tick issues nothing.
- Before each ALTER, read `unreserved_space` (`checkDiskHeadroom`). Need = `largest_part_bytes` x 1.1 + 5 GiB. Short of it, the partition is *skipped*, not attempted: `console.warn('[projection-scope] skipping <p>: needs about X free, have Y')`, and the tick goes on.
- The ALTER is sent with `clickhouse_settings: { alter_sync: 0, mutations_sync: 0 }`: the cron queues the work and returns; it no longer holds an HTTP request for 60 s (or 14.8 h) on a wedged queue.
- `ProjectionScopeTickResult` gains `skipped: Array<{ partition: string; reason: string }>`; the log line is `cutoff=<c> cleared=[...] skipped=[...]`.
- `projection-scope-cron` and the dedup cron keep their env switches (`PROJECTION_SCOPE_CRON_HOURS`, `DEDUP_CRON_HOURS`, `DEDUP_CRON_HOUR_UTC`).

### 4. Cron scheduling — `lib/daily-schedule.ts` (new)

```ts
export function scheduleEveryHoursFromAnchor(opts: { anchorHourUtc: number; everyHours: number; run: () => void | Promise<void>; now?: () => number; pollMs?: number }): { cancel(): void; nextRunAt(): number }
```
- `nextRunAt` starts at the next `anchorHourUtc:00 UTC` (`msUntilNextRun`, which stays exported from `lib/dedup-cron.ts`). A 30 s poller (`setInterval`, `unref`) compares `Date.now()` with it; when due it runs `run()` once, then advances `nextRunAt` by `everyHours` until it is in the future (a long suspend yields one catch-up run, not a burst).
- A poller on the wall clock instead of one long `setTimeout`/`setInterval`: this laptop suspends, and Node timers use the monotonic clock, which does not advance during suspend, so a 20-hour timer lands late by the length of the sleep.
- Both crons use it; their start-up log lines (`first tick in Nm (anchored to HH:00 UTC), then every Nh`) stay. The existing source-contract tests that assert on the old `setTimeout`/`setInterval` text are replaced by behaviour tests.

### 5. CI and dependencies

- `.github/workflows/ci.yml`: `runs-on: ubuntu-24.04`; `actions/checkout@v7`, `actions/setup-node@v7` (the current majors, not v5: v5/v6 are older lines). Steps unchanged.
- Dependencies: only the four advisories with non-major fixes (`next`, `sharp`, `source-map-js`, `postcss-nested`), through `npm audit fix` without `--force`, then proven on disk, not by the command's own report (an earlier `npm audit fix` in this repository reported success and left `node_modules` untouched): `npm ci`, then read `node_modules/<pkg>/package.json` for each. Expected result: the remaining findings are the dev-tooling chain that needs the Tailwind 4 / `eslint-config-next` majors, which stay a separate decision. Full suite, `tsc`, eslint, `next build` and a production image build must pass.

### 6. Cleanup and docs

- `git worktree remove .claude/worktrees/search-dictionary` and `git branch -d worktree-search-dictionary` (merged into `main` at `affe60f`, tree clean, no lock, the owning session is gone).
- Delete `styles/globals.css` (`app/layout.tsx` imports `app/globals.css`) and `public/placeholder.jpg`, `placeholder-logo.png`, `placeholder-logo.svg`, `placeholder.svg`, `placeholder-user.jpg`; each is re-checked with a repository-wide grep at implementation time.
- `.gitignore`: add `.claude/settings.local.json`; commit `.claude/launch.json`.
- `docker-compose.yml` forwards `INGEST_MIN_FREE_BYTES` and `INGEST_DISK_GATE` (compose does not pass arbitrary `.env` keys); `.env.example` and `README.md` document both next to the disk-watch and spool variables.

## Verification plan (empirical, per the project's own rule)

Unit tests are mocks; the 2026-10-04 rehearsal found two ClickHouse bugs they could not. So both layers:

1. **Unit (vitest, injected check / sleep / clock):** gate (config parsing, proceed above the floor, pause below, resume only at floor x 1.1, `onPoll` and abort on every poll, read failure pauses, `off` is a no-op, two waiters share state, cache window); `describeDiskBanner` as a table; the route (401, 403, admin shape); projection-scope tick with a fake client (empty eligibility issues no ALTER; short of space skips and logs; enough space sends `alter_sync: 0`); the scheduler with fake timers (anchor, `everyHours`, suspend catch-up runs once, cancel). Existing disk-watch, ingest-health and cron tests stay green.
2. **Live, read-only:** a `*.live.test.ts` runs the new eligibility SQL on the real server and checks it returns only partitions present in `system.projection_parts` (today: none).
3. **Isolated stack on the production image** (`docker-compose.rehearsal.yml`, as `scripts/e2e-alert-rehearsal.ts`; about 6 GiB RAM, about 4 minutes; test credentials only), new `scripts/e2e-disk-gate.ts`: the stack starts with `INGEST_MIN_FREE_BYTES` = (host free space - 2 GiB) / 1.1, so the resume level (floor x 1.1) sits 2 GiB under the starting free space; (a) an upload completes; (b) a filler (`fallocate`, about 13 GiB today: start free - floor + 1 GiB) written inside the rehearsal ClickHouse volume drops free space 1 GiB under the floor: the next upload stays pending, `GET /api/monitoring/disk` returns `gate.paused = true`, and the log has one "pausing" line; (c) removing the filler resumes it by itself and the file lands with the right row count; (d) `INGEST_DISK_GATE=off` imports regardless. Plus the projection-scope skip on a two-partition scratch table.
4. **Gates:** `tsc`, eslint, the full suite, `next build`, the Docker image build.

## Rollout

- A branch in the primary checkout (`sp1-disk-safety-hygiene`), no worktree: the worktree hazards recorded for this repo (nested paths, blank Docker env, ESLint cascade, empty `node_modules`) buy nothing for a change this size. Small commits, TDD.
- Fast-forward merge to `main`, push, CI green (the first run exercises `ubuntu-24.04` and the v7 actions).
- Build the image, tag the running one `ulp-suite-app:rollback-<UTC timestamp>`, recreate only `app` (`up -d --no-deps app`, scoped `DOCKER_CONFIG`, mounts and secrets checked). The app is down for about 30 s: done between searches.
- Afterwards: startup log shows the crons armed; the next 04:00Z / 05:00Z ticks appear at those times; the banner shows on the next login.
- Rollback: retag the previous image and `up -d --no-deps app`; or set `INGEST_DISK_GATE=off` for the gate alone.

## Deliberately NOT done

- **The dedup auto-apply and the archive.** `.env` arms `CONTENT_DEDUP_APPLY=true` with `DEDUP_MIN_EXCESS=14000000`; an import that leaves 14M duplicate rows makes the next tick drop `credentials_predup_auto` (381 GiB) in step 2, before the disk guard's `preflight()` (step 5), then rewrite the table. That order is intentional (the drop makes room), so it is not changed here; sub-project 2 (novelty-aware ingest keeps the excess near zero) and the operator decide the apply setting. Until then the pending download pile must not be imported.
- Push alerts (declined; `DISK_ALERT_WEBHOOK_URL` still works if set), ClickHouse `keep_free_space_bytes` (config plus a restart, a possible follow-up), host log caps (the operator's `sudo`), the major upgrades (Tailwind 4, `eslint-config-next`, Next 16, ...), the hardening bundle (`2026-10-03-hardening-bundle-design.md`), a `next build` step in CI, one-word search speed.
