# Near-duplicates: one credential, several spellings — Design

Date: 2026-11-01
Status: **Stage 1 implemented and deployed locally on 2026-11-01** (main `867c296`, CI green, image `b784aa285d4b`, rollback tag `rollback-20261101-1952z`); the backfill finished the same evening and the exact look-alike share is 6.94%; the first import on the normalised key has not run yet (see "As deployed"). **Stage 2** (remove the look-alikes already stored) is designed here, needs its own explicit go from the owner and is not started.
Related: `2026-06-28-credential-url-content-key-design.md` (the exact key), `2026-07-07-content-dedup-rewrite-swap-design.md` (the rewrite engine), `2026-10-02-novelty-aware-ingest-design.md` (the intake this changes).
Measured read-only on 2026-11-01 on the live server (ClickHouse 26.3.17.4). `ulp.credentials` held 2,585M rows when the measurements were taken and 2,606M rows (241.65 GiB, 16 active parts) when this was written; the root disk has 247 GiB free. File names, search terms and credential values are deliberately absent (the repository is public); the examples use invented `.example` hosts.

## Why

Two rows are one credential when the site, the login and the password agree. The table already treats `http://`, `https://` and one trailing slash as the same site (`content_key_hash`, since 2026-06-28), and it holds no exact duplicate: 0 in a 1/64 hash sample of 40.4M rows. What it still stores twice is a row that differs only in how the same thing was typed or logged:

| | url | login | password |
|---|---|---|---|
| row A | `https://www.Shop.example/login/` | `Sam@Mail.example` | `example-pass` |
| row B | `http://shop.example/login` | `sam@mail.example` | `example-pass` |

About 8.0% of the rows (about 207M of the 2,585M) are surplus: they collapse into another row once these spellings are ignored. The importer keeps adding them: 12.5% of the rows imported since 2026-10-30 are look-alikes of an older row or of each other. The cost is accuracy, not space. Every count (the Credentials header, Site Counts, the import cards) carries about 8% surplus rows, the "already in the database" check that protects every import cannot see a look-alike, and a login-case twin can raise a second monitor alert (the alert fingerprint is made from the login as stored).

## The rule

Two rows are the same credential when, after these steps, the URL part, the login and the password are equal:

1. Drop a leading `http://` or `https://`, in any case (done today).
2. Drop a leading `www.` and lower-case the host, meaning the text up to the first `/`, `?` or `#`.
3. Drop every trailing slash (today: one).
4. Lower-case the login (ASCII; every login, user names included).

Everything else is compared as typed: the password, the port, the path and its capitals, the query, the fragment. One definition, written once in `lib/url-content-key.ts` and copied into the init SQL:

```sql
-- s = replaceRegexpOne(url, '^(?i:https?://)', '')
cityHash64(
  concat(lower(extract(s, '^(?i:www\\.)?([^/?#]*)')),   -- host: no leading www., lower case
         extract(s, '^[^/?#]*(.*?)/*$')),               -- the rest of the URL: no trailing slashes
  lower(email), password)
```

`concat` cannot confuse two keys: the second part always starts with `/`, `?` or `#`, or is empty, because the first part stops at the first of them. Equal keys mean equal hashes, as with the exact key today; Stage 2 also compares the key text.

Checked on ClickHouse 26.3.17.4 (host part and rest, as the expression computes them):

| url | host part | rest |
|---|---|---|
| `https://www.Example.COM/Path/` | `example.com` | `/Path` |
| `http://example.com/Path` | `example.com` | `/Path` (the same key as the row above) |
| `HTTPS://WWW.example.com` | `example.com` | empty |
| `https://example.com:8443/a//` | `example.com:8443` | `/a` (the port stays) |
| `HTTP://www.Example.com:80/a/` | `example.com:80` | `/a` (`:80` is not folded) |
| `https://example.com/a#frag` | `example.com` | `/a#frag` (kept) |
| `https://example.com/?x=1/` | `example.com` | `/?x=1` |
| `https://www.www.example.com/` | `www.example.com` | empty (one `www.` only) |
| `https://user:Pw@Host.com/x` | `user:pw@host.com` | `/x` (see below) |
| `ftp://www.x.com/a` | `ftp:` | `//www.x.com/a` (non-web forms keep their text) |
| `android://abcDEF@com.app.name/` | `android:` | `//abcDEF@com.app.name` |
| empty url | empty | empty |

A `user:pw@` in an http(s) host is lower-cased with the host (0.30% of the rows of a 1/64 sample of the whole table carry one). Two rows merge only when the path, the login and the password also agree, so this over-fold is accepted. A host that is exactly `www.com` becomes `com`, which is not a real host.

## What was measured

**Method.** The table is ordered by `(domain, email, imported_at)` and the parser stores `domain` lower-cased with `www.` and the port stripped, so look-alikes share a `domain` and sit in the same domain range: counting inside a range sees every twin of its rows. 24 ranges of 2.5M to 7M rows each, 139.7M rows in all (5.4% of the table). For each variant: exact keys minus distinct keys when only that variant is ignored, as a share of the rows. The SQL above was checked against the measured form on 3 ranges (5,660,709, 5,931,270 and 6,649,910 distinct keys, equal on all three).

| Spelling difference, ignored alone | Share of rows that collapse |
|---|---|
| leading `www.` | 6.20% (0.16% to 9.61% by range) |
| capitals in the login | 1.69% (about 84% of those logins are user names, not e-mail-shaped) |
| capitals in the host | 0.04% |
| two or more trailing slashes | 0.01% |
| default port `:80` / `:443` (not folded) | 0.002% |
| `#fragment` or an empty `?` (not folded) | 0.001% |
| blanks around the login or the password | 0 |
| **the rule (www, host case, trailing slashes, login case)** | **8.02%** |

The measured set also folded the default ports; they add 0.002%, below the precision of the figure. Between the 24 ranges the standard error is about 0.4 points, so 7.2% to 8.8%, that is 186M to 228M of the 2,585M rows (point estimate 207M); by range 2.15% to 10.72%. The ranges are consecutive domain prefixes and not a random sample, so read the figure as an estimate good to a point or two. The exact figure comes cheaply after the Stage 1 backfill: a 1/64 bucket of `norm_key_hash` holds whole groups, so rows minus distinct keys inside it is an unbiased estimate (about 40M rows, 16 s). It replaces this estimate before Stage 2 is proposed: **measured after the backfill, 6.94% (about 181M rows), below this band; see "As deployed".** Twin groups are 96.8% pairs, 2.7% triples and 0.5% larger.

**Not folded, and what folding would add** (8 ranges, 47.7M rows):

| Candidate | Extra collapse | Why it stays out |
|---|---|---|
| capitals in the path | +1.07% | a case-sensitive server may serve different pages |
| `/index.html`, `.php`, `.asp`, `.jsp` as the last part | +0.32% | the same |
| `googlemail.com` = `gmail.com`; `+tag`; dots in a Gmail name; a dot after the host | 0.000%; 0.007%; 0.006%; 0.001% | too small |
| same host + login + password under any path | +19.34% (28.0% of all rows by itself) | not a duplicate URL: one account seen on many pages; a separate question (see Not in scope) |

**It keeps growing.** In 6 ranges holding 35.5M rows, 5.69M were imported since 2026-10-30. Of those, 12.54% (0.71M; 11.0% to 16.1% by range) are look-alikes of an older row or of each other, which is about 45M of the 357M rows added by then (377M on the day of writing). The older rows carry 9.10% surplus.

**Login case.** Folding user names too is worth 1.3 of the 1.7 points that login case collapses (8 ranges).

## Decisions

| | Decision | Reason |
|---|---|---|
| D1 | Fold the login's ASCII case for every login, user names included | 1.3 of the 1.7 points are user names. My recommendation, approved with the design. It is decided before the column exists: changing it later means a new backfill. |
| D2 | The port stays as typed | default-port twins are 0.002% of the rows |
| D3 | The path, query and fragment stay as typed | path capitals and `/index.*` could be different pages; a fragment is 0.001% |
| D4 | First seen wins at intake; no stored value is rewritten | the survivor the content dedup is documented to keep (earliest `imported_at`), and the typed form stays |
| D5 | A new column `norm_key_hash`; `content_key_hash` is not redefined | `proj_imported_desc` (62.45 GiB) carries `content_key_hash`; changing it, or reading a computed key where the projection serves (the default Unique view), means rebuilding that projection (28 minutes at the 2026-09-30 cutover, when the table had 1.39B rows) |
| D6 | An import chooses its key once and uses the normalised one only when the column is complete; `INGEST_NORM_KEY=off` forces the exact one | the deploy order stops mattering and no import takes the slow on-the-fly path |
| D7 | Inside an import the two statements that pick a row per key (the insert and the monitor match) pick the same one: the first by `(url, email)` | see "Which twin is kept"; gated on cost |
| D8 | Removing what is stored (Stage 2) is a separate, explicit go | it rewrites the table and needs room |
| D9 | No read-side change: Unique, the counts and the Newest-first windows keep `content_key_hash` | the projection carries it; surplus rows stay visible until Stage 2, as today |

## Stage 1: stop new look-alikes

### The column

`norm_key_hash UInt64 MATERIALIZED <the key>` on `ulp.credentials` and on every stage table (the stage keeps `content_key_hash` too: the exact key is the fallback). Size: +19.5 GiB. A random 64-bit hash does not compress: `content_key_hash` takes 19.43 GiB, 8.03 bytes a row. Free disk goes from 247 GiB to about 228 GiB; the warning level is 187.4 GiB and the critical floor 140.5 GiB.

Code and DDL: `lib/url-content-key.ts` exports builders for both keys over any column expressions (`scripts/pile/verify-file.ts` hand-copies the exact key over `unhex(...)` today; it will call the builders). `lib/clickhouse-migrations.ts` gets DDL v30. `docker/clickhouse/init/01-ulp-tables.sql` carries the definition, and a test locks it to the TypeScript text for both keys. `lib/clickhouse-migration-safety.ts` adds the column to `MIGRATION_COLUMNS`. `lib/ingest-stage.ts` adds it to the stage.

DDL v30 is `ADD COLUMN IF NOT EXISTS` only: metadata, instant. It does not fire the backfill (the rule since v23 and v29: start-up is not coupled to a mutation). A failed ADD is not recorded as done, so the next start tries again, as for v28 and v29.

### The backfill (supervised)

`scripts/materialize-norm-key.sh`, in the shape of `scripts/materialize-address-index.sh`: a dry run by default, `APPLY=1` to run. It runs `MATERIALIZE COLUMN norm_key_hash IN PARTITION <p>` one partition at a time, the smallest first (202611: 38.2M rows, 5.2 GiB on the day of writing), so the first run measures the rate and the disk change before the 140 GiB partition (202610; its largest part is 98.24 GiB). It refuses to start while another mutation runs on the table or while free disk is under 170 GiB, and kills its mutation under 155 GiB (floor 140.5). It ends by checking that (a) the readiness query below says ready, (b) in a 1/64 sample (`content_key_hash % 64 = 0`) the stored value equals the expression for every row (0 mismatches), and (c) it prints the exact twin share from that sample.

Cost: the key computes at 5.4M rows a second on 8 threads at a load of about 16, so about 8 minutes of computing for the whole table. Wall time was estimated at 15 to 30 minutes; the run took 46 minutes of mutation (see "As deployed"). A column mutation should hard-link the files it does not touch (none of the three projections depends on the column), so the transient disk is about the new column only; the first partition shows it (its size grows by about its column, not by its projections). Run it with no import running: it competes for CPU on a thermally limited laptop.

### Choosing the key for an import

`INGEST_NORM_KEY`: on by default; `off`, `0` or `false` uses the exact key everywhere, which is today's behaviour. When on, an import uses `norm_key_hash` only if the column is complete: it exists in `ulp.credentials`, and the number of active parts equals the number that list `norm_key_hash` in `system.parts_columns`. Checked on a scratch table on 2026-11-01: after `ADD COLUMN` and one more insert, 3 parts and 1 listing the column; after `MATERIALIZE COLUMN`, 3 and 3. Parts that lack the column compute it on the fly, which gives the right value but reads three columns instead of one. An empty table counts as complete. The query is metadata only, fails closed (any error or odd answer means the exact key) and is cached for 60 s when ready and 5 s when not, like the Newest-first readiness gate (`lib/newest-first.ts`). Once every part has the column, later parts do too: inserts compute it and merges of parts that hold it keep it.

The choice is made once, before the first slab, so a file never mixes keys. It is logged with `console.warn` when it changes and recorded in the job: a nullable `processing_jobs.match_key` (`norm` or `exact`; null on a job from before this release means exact), added the way `repeats` was. The direct path (`INGEST_NOVELTY_CHECK=off`) has no stage and no novelty check; it is unchanged.

### The intake

Everything in `lib/ingest-novelty.ts` that names `content_key_hash` takes the key column as a parameter: the slab predicate, the distinct count, the known fill, the commit insert (`NOT IN known` and `LIMIT 1 BY`) and the monitor query. A twin always lands in the same slab, so a look-alike inside the file counts as a repeat and one already in the table counts as known. The known table's column is renamed `key_hash`. The accounting checks (`known <= distinct`, `written == distinct - known`) hold unchanged for either key.

What the owner sees: `known` and `repeats` rise and `imported` falls, by about one new row in eight (12.5%). `imported + known + repeated + rejected = lines of the file` still holds.

**Which twin is kept.** Today any row of a group will do, because exact twins differ only in the scheme or one slash. Look-alikes can differ in the login's case, and a monitor fingerprint uses the login as stored: if the insert stored one spelling and the monitor query reported the other, a later rescan would alert again on the stored one. So when matching on the normalised key both statements pick, per key, the row that sorts first by `(url, email)`: `ORDER BY url, email LIMIT 1 BY <key>` (in the monitor query the sort comes after its WHERE, so it sorts only matching rows). With the exact key the statements stay exactly as they are today, so `INGEST_NORM_KEY=off` is today's behaviour to the letter. The sort spills to disk above a bound (`max_bytes_before_external_sort`) instead of growing memory. Gate: on an all-new slab of the size an import uses on this key, the commit statement may take at most 1.25 times the time and 1.10 times the peak memory of today's, measured on the rehearsal stack against the old statement the same day. The commit insert is 12% to 14% of a big import (263 s and 322 s of 36.5 and 37.9 minutes on 2026-11-01), so the time limit costs an import at most 3% to 4%. Over a limit, the plan stops and reports instead of shipping an arbitrary pick.

**The first measurement, and the slab cap it led to (2026-11-01, rehearsal stack).** At a 20M-row slab the time passed (0.91: 69 s against 76 s) and the memory did not: the new statement peaked at 10.6 GiB against 7.9 to 8.1 GiB for today's, and a server capped at 9 GiB killed it. The spill bound does not keep the memory flat. Production's ceiling is 14 GiB and a commit starts while the server is under 75% of it (the memory guard), so a statement of 10.6 GiB can be killed by the over-commit tracker and fail an import part-way (a retry is safe, but it is a regression). Memory follows the slab, so on the normalised key a slab holds at most 10,000,000 rows (`NORM_KEY_MAX_SLAB_ROWS`; a smaller `INGEST_NOVELTY_SLAB_ROWS` is kept; the exact key keeps its slab size). Measured: 10M rows, peak 7.1 to 7.2 GiB against 7.5 for today's statement, time ratio 1.12; 5M rows, 4.3 against 4.95 GiB, ratio 0.81. The price is one more pass over the key column per 10M rows of a file: about 20 s each at 2.6B rows (an estimate from the 10 s measured at 1.4B), about 2% of a 48M-row import.

**Monitors.** They still see only new rows. A login-case twin of a stored row is no longer new, so it no longer alerts a second time. The fingerprint is unchanged.

### The per-file recount

`scripts/pile/verify-file.ts` recounts a file with its own copy of the exact key. It takes the key from `lib/url-content-key.ts` and, per job, the rule the job recorded (`match_key`; no record means exact), and probes `norm_key_hash` or `content_key_hash` to match.

### Rollout and rollback

1. Tag the running image (`rollback-<UTC>`), build a candidate under its own tag, rehearse it (below) with `REHEARSAL_APP_IMAGE`, and run `docker compose` from the primary checkout only.
2. Deploy. Start-up adds the column; new rows carry the value; imports keep the exact key (the column is incomplete).
3. Run the backfill, smallest partition first, with no import running. The first import after it ends uses the normalised key by itself.
4. Check that import: `match_key = 'norm'`, the accounting identity, `known` and `repeats` up as predicted; and in a 1/64 bucket of `norm_key_hash` no group contains a row imported after the flip.

Rollback: `INGEST_NORM_KEY=off` and recreate the app, or redeploy the rollback image. That image never reads the column (a materialized column is invisible to its insert lists and to `SELECT *`), and the DDL version it finds recorded (30) is above its own (29), so it skips every step. The 19.5 GiB column can stay, or go with a cheap `DROP COLUMN`.

### Tests and rehearsal

Unit: the builders for each key; the expression text, locked like `__tests__/url-content-key.test.ts`, and its equality with the init SQL; the setting; the readiness decision (ready, not ready, odd answers); the migration (runs once; a failure is not recorded as done); `MIGRATION_COLUMNS`; the wiring test (compose, rehearsal compose, `.env.example` and the README name the setting); the key choice in `verify-file`.

On a real ClickHouse (a mocked query once passed with two real bugs in it):

- A golden table: the URLs of the edge-case table above through the expression, with the exact expected host part and rest.
- `scripts/e2e-novelty-ingest.ts`, two new scenarios. `lookalikes`: rows that differ by `www.`, host case, a slash, the scheme or the login's case (e-mail and user name) are one credential; rows that differ by path, path case, port or password are separate; look-alikes inside the file count as repeats and those already stored as known; the stored row of a group is the first by `(url, email)` and the monitor alert shows that same row. `norm-not-ready`: on a table whose column was dropped and added again (existing parts lack the value) the import uses the exact key and records `exact`; after `MATERIALIZE COLUMN` the next one uses the normalised key and records `norm`.
- Every existing scenario again, under the new default (a fresh init has the column complete from the start). A fixture row that happens to be a look-alike changes a count; the plan finds and fixes those.
- The cost gate above, and the first partition's time and disk change.
- On the live table, read-only: the final SQL text gives the same distinct counts as the measured form on the 3 ranges.

### Files, docs and settings

Files touched: `lib/url-content-key.ts`, `lib/clickhouse-migrations.ts`, `lib/clickhouse-migration-safety.ts`, `docker/clickhouse/init/01-ulp-tables.sql`, `lib/ingest-stage.ts`, `lib/ingest-novelty.ts`, `lib/ingest-novelty-config.ts` (the setting), a small readiness module beside them, `lib/upload-processor.ts` (choose the key, pass it to the commit, return it), `lib/sqlite.ts` and the job-log writers (`match_key`), `scripts/materialize-norm-key.sh` (new), `scripts/pile/verify-file.ts`, `scripts/e2e-novelty-ingest.ts`, `scripts/e2e-alert-rehearsal.ts` (the DDL version it expects), `scripts/measure-commit-sort-cost.ts` and `scripts/check-norm-key-parity.ts` (new; the cost gate and the read-only parity check), their tests, and the settings files below. The views, `lib/ulp-dedupe.ts`, `lib/content-dedup.ts` and the parser are not touched.

`INGEST_NORM_KEY` is forwarded in `docker-compose.yml` and in `docker-compose.rehearsal.yml` (`REHEARSAL_INGEST_NORM_KEY`), and described in `.env.example` and in the README settings list. The README's Unique and Content-deduplication passages say what counts as the same credential and that stored look-alikes remain until Stage 2. The novelty-ingest spec gets a pointer here.

## Stage 2: remove the look-alikes already stored (needs the owner's explicit go)

Not in the first plan. What is fixed now, and what its own plan decides.

**Fixed.**

- A group is the rows with one `norm_key_hash` and the same key text: the text is compared before a row is removed. A 64-bit hash over 2.6B rows is expected to collide on about 0.2 pairs (n^2 / 2^65), and a collision must never remove a different credential.
- The survivor is the row with the earliest `imported_at`, ties by `(url, email)`: first seen wins, as at intake.
- A removed row is written to an archive table first (every stored column, the survivor's exact key and the removal time; about 20 GiB, no projections). Nothing leaves the table unarchived.
- `was_duplicated` is set to 1 on a survivor that absorbed twins (its existing meaning). No stored value is rewritten.
- Proof, per partition: rows before = rows after + archived; distinct `norm_key_hash` before = after; after, a 1/64 bucket has no group of more than one row, and the exact-duplicate check still gives 0.
- Preconditions: no import running; free disk for the chosen mechanism; the owner's call on `credentials_predup_auto`; the exact twin share from the Stage 1 backfill in front of the owner.

**Mechanism: two candidates; the Stage 2 plan picks after a rehearsal on a copy of the smallest partition.**

- **A. The existing insert-select-rename engine** (`lib/content-dedup.ts`: a bucketed build, verify, atomic swap, catch-up and projection restore) pointed at the normalised key, with the survivor order `imported_at, url, email`. Proven at this scale: 2.78B to 1.39B rows on 2026-09-30 in 2.5 hours with 16 buckets, plus a 28-minute projection restore. It builds a second copy of about 222 GiB (92% of 241.65 GiB) on top of the live table. Free is 247 GiB, so it works only after `credentials_predup_auto` (138 GiB) is dropped: 385 - 222 = 163 GiB left, 22 above the floor. The old table then becomes the new pre-dedup archive (241 GiB) until the owner drops it. About 3 hours with imports paused (my estimate from the 2026-09-30 run).
- **B. One heavyweight `ALTER TABLE ... DELETE`** by a loser list keyed by the exact `content_key_hash` (unique per row, there being no exact duplicate). The transient disk is the parts being rewritten (the largest is 98.24 GiB), and their projections are rebuilt. Unproven at this scale: the history in `lib/content-dedup.ts` (an unchunked DELETE hit the memory limit at 2.8% of the table; a chunked one was estimated in weeks) used a key computed inside the DELETE, and a precomputed loser table may behave differently. That has to be shown, not assumed.
- Lightweight `DELETE` is out: the table's projections reject it.

Recommended: A, if the owner will drop `credentials_predup_auto`; B only after it is shown on a copy of one partition.

**What changes afterwards.** Counts drop by 6.94% (about 181M rows; the design estimate was 8%, 207M, see "As deployed"). Disk falls by about 18 GiB (6.94% of the table's 261.08 GiB with the column), which pays back most of the 19.4 GiB the column took. The per-file recount holds as rows in the table + rows in the archive = rows the job added. Monitor fingerprints live in SQLite and are untouched; a survivor whose own spelling never alerted can alert once on a rescan.

## Rejected

- **Hide twins at read time** (Unique on `norm_key_hash`): every query that de-duplicates on `content_key_hash` changes, and `proj_imported_desc` cannot serve a key it does not carry; adding the column to it costs 19.5 GiB and a rebuild, for an 8% change to the counts.
- **List the variants at intake** (look up `www.x` and `x`, upper and lower case): a login can carry capitals anywhere in it, so the variants cannot be listed.
- **Normalise in the parser** (store the login lower-cased, strip `www.`): it rewrites what is stored, loses the typed form, and still leaves the 207M already there.
- **Redefine `content_key_hash`**: the projection rebuild above.
- **Do nothing**: 12.5% of every batch keeps leaking in.

## Not in scope

- Path capitals, `/index.*`, Gmail aliases and default ports (table above).
- The same account under any path (28.0% of the rows by itself): a count of accounts over host, login and password, not a duplicate. If it is wanted it is its own design.
- The parser, the views and any screen.

## Risks and their limits

| Risk | Limit |
|---|---|
| A hash collision makes two different credentials one | about 0.2 colliding pairs expected in the whole table (n^2 / 2^65), as with the exact key today; Stage 2 compares the key text |
| The backfill competes with imports and the laptop's cooling | no import running; the smallest partition first; abort at 155 GiB free |
| Over-folding | ASCII `lower` only; the host part (any `user:pw@` in it) is lower-cased, and two rows merge only if the path, login and password also agree |
| The cards look different (more "already in the database") | the README says why; `match_key` records which rule each import used |
| The sort slows the commit or grows its memory | the 1.25 times (time) and 1.10 times (peak memory) gates, and a slab on this key holds at most 10,000,000 rows |

## Done when (Stage 1)

1. DDL v30 is on the live table with no data rewrite and the app healthy; imports before the backfill record `exact`.
2. The backfill finished, the readiness query says ready, the 1/64 check has 0 mismatches, and the exact twin share is on record.
3. The first import after it records `norm`; the accounting identity holds; the 1/64 bucket check (no group with a row imported after the flip) gives 0; the exact-duplicate check still gives 0.
4. The rehearsal passed (existing and new scenarios), the cost gate held, CI is green, and the README, `.env.example` and both compose files carry the setting.

## As deployed (Stage 1, checked on the running system on 2026-11-01)

Numbers only. Items 1, 2 and 4 of "Done when" are met; item 3 (the first import on the normalised key) is still to be seen.

**Release.** Main `867c296`; CI on it passed in 3 min 1 s. Image `b784aa285d4b`, rollback tag `rollback-20261101-1952z` (`2ca4ce8ad568`). DDL v30 applied at the app's start-up as a metadata change; free disk did not move (246 GiB). No import ran between the deploy and the end of the backfill, so none could have used the exact key by mistake or the normalised key too early.

**Rehearsal on that image** (fresh isolated stack). Alert rehearsal 50 of 50. Full end-to-end run 254 of 254, including the new scenarios `golden` (13 of 13 edge cases), `lookalikes` and `norm-not-ready`. Cost gate at the 10,000,000-row cap: time ratio 0.92, peak memory 7.09 GiB against 7.49 GiB (0.95). The backfill script on a real ClickHouse: dry run, one partition and the whole table (44M rows in 58 s). Read-only parity on the live table, 3 ranges and 19.3M rows: the independent form equals the table's expression.

**The backfill on the live table** (4 mutations, run partition by partition, smallest first, no import running):

| Partition | Rows | Time |
|---|---|---|
| 202611 | 38.2M | 52 s |
| 202608 | 496.7M | 633 s |
| 202607 | 897.7M | 1,099 s |
| 202610 | 1,173.7M | 997 s |

In all 2,606,332,363 rows in 2,781 s (46.4 minutes), then under 2 minutes of final checks. The first partition's rate predicted 59 minutes for the table; the run took 22% less because the parts of a partition are rewritten in parallel (a partition takes as long as its largest part: 833M rows in 997 s). Free disk went from 245 GiB to 226.1 GiB, in small steps as parts finished, never by the size of a part, so the unchanged column files were hard-linked. The column is 19.41 GiB (8.00 bytes a row) and the table 261.08 GiB (241.65 GiB before). The lowest free disk seen was 226.1 GiB, against the warning level of 187.4 GiB, the floor of 140.5 GiB and the script's own limits (refuse under 170, abort under 155).

**Checks at the end.** All 16 parts hold the column. In the 1/64 sample (`content_key_hash % 64 = 0`, 40,722,205 rows) the stored value equals the expression for every row (0 mismatches). The exact-duplicate check on the same sample: 40,722,205 rows and 40,722,205 distinct exact keys.

**The exact look-alike share.** In a 1/64 bucket of `norm_key_hash` (it keeps whole groups, so rows minus distinct keys is an unbiased estimate): bucket 0 has 2,826,735 surplus rows of 40,721,523 (6.94%); buckets 1 and 2 have 2,825,191 of 40,713,226 and 2,824,730 of 40,730,411 (6.94% each). So 6.94% of the table, about 181M rows, collapse into another row. That is below the design estimate (8.02%, band 7.2% to 8.8%), which came from 24 consecutive domain ranges that were not a random sample (by range 2.15% to 10.72%). The three buckets agree to 0.01 points, and the rule was checked directly (stored value equals the expression on the sample, the independent form equals it on 3 live ranges, 13 of 13 edge cases), so the gap is the data and not the key. Removing the stored look-alikes (Stage 2) would free about 18 GiB.

**The existence check at full size.** The import's per-slab pass, measured read-only on the live table (the distinct keys of the table that are in a 10,000,000-key set matching nothing): 25.4 s on `norm_key_hash`, 25.4 s on `content_key_hash`, 25.5 s on a repeat of `norm_key_hash`. The normalised key costs the same per pass as the exact one. The slab cap adds one such pass for every extra 10,000,000 staged rows: a 48,000,000-row file goes from 3 passes to 5, about 51 s more.

**Still to see.** The first import on the normalised key: its recorded `match_key`, that `imported + known + repeats + skipped` adds up, its `known` and `repeats` against a file of its kind before, and the bucket check that no group of look-alikes holds a row imported after it.
