# Site marks: a status and a note that stay with a site — Design

Date: 2026-10-29
Status: **designed and approved in chat on 2026-10-29; not built.** First release: three marks, a note, a filter and a sort by mark, on the Site Counts page. The sites in this file are made up (`corp.example`): the owner's lists stay on the owner's machine.

## Why

The Site Counts page keeps nothing between visits: a count is a table in the page's memory and is gone on a reload. What a person decides about a site (looked at it, not worth it, still to do) has nowhere to live, so the next count of the same list starts from the same blank table.

The ask: a mark in a cell just left of the Rows column, a green check, a red X or a blue circle, that is kept, so a site that comes up again shows what was decided about it, "or anything else". Of the extras offered, the owner chose a **note per site** and a **filter and sort by mark**. A mark column in the CSV and statuses the owner defines in a settings screen were offered and not chosen (see Not done).

## What a mark is

A mark is a **status** and a **note**, each optional. A site has a stored mark while either is set; clearing both removes it.

| Status | Label | Icon | Colour |
|---|---|---|---|
| `done` | Done | check in a circle | green |
| `skip` | Skip | X in a circle | red |
| `todo` | To look at | solid dot | blue |
| none | No mark | faint empty circle: on hover and keyboard focus, always on a touch screen | grey |

What the three mean is the owner's call; the labels are text in one list (`SITE_MARK_STATUSES`), so renaming one is an edit of that list. Shape and text carry each status, not colour alone: the tooltip and the accessible name say the label. "No mark" means no status, so a site with a note and no status is "No mark" with a note.

## Which site a mark belongs to

A mark belongs to the site the counts name: the `host` of a count (`siteEntry`, `lib/site-counts-input.ts`, which cleans away a URL, `www.`, `*.`, `host:port`, quotes and a path). `https://www.corp.example/login`, `corp.example` and `*.corp.example` show one mark, as they show one count. A mark on `corp.example` is about the site as the counts define it, the host and every subdomain; a subdomain listed as its own entry (`app.corp.example`) is its own site with its own mark. A path is ignored, as it is for the counts.

The server accepts a host for writing only when the cleaning leaves it unchanged (`siteEntry(host).host === host`) and looks hosts up exactly as given, so the page and the server cannot disagree about a key. Checked on twelve spellings: every ordinary one is unchanged, including two leading `www.` (counted as the bare host), and three or more leading `www.` are the one shape the cleaning still changes on a second pass. The page shows no control on a row that has no host ("not a site address") or whose host the cleaning would change again; that row cannot be marked.

A mark is shared: everyone who signs in sees and changes the same marks. Each keeps who changed it last (an e-mail address, or the sign-in name when the token carries none; visible to everyone who can open the page) and when. A mark per person is one more key column; not done.

## Storage

One new table, created in `initSchema` of `lib/sqlite.ts` like the others; the store is `lib/site-marks.ts`.

```sql
CREATE TABLE IF NOT EXISTS site_marks (
  host       TEXT PRIMARY KEY,
  status     TEXT,                                      -- 'done' | 'skip' | 'todo', checked in code; NULL = no mark
  note       TEXT,                                      -- at most 500 characters; NULL = no note
  updated_by TEXT,                                      -- e-mail of whoever changed it last
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),   -- UTC, as the other tables
  CHECK (status IS NOT NULL OR note IS NOT NULL)        -- a row holds a mark, a note or both
)
```

Why SQLite: marks are small, set by hand and owned by the owner, as users, monitors and webhooks are. ClickHouse holds the 2.2 billion credentials, and a table of hand-set marks there would need a DDL, a rehearsal and a scheme for rows that change, to hold what SQLite holds with one `CREATE TABLE`. Browser storage is per browser and goes with the site data, which is not "remembered". The table is additive (`IF NOT EXISTS`, no change to another table), so the image that ran before ignores it and a rollback loses nothing; the SQLite snapshots (`backupDb`, `lib/sqlite-backup.ts`) copy the whole database and include it.

The status is text checked against the list in code, not a `CHECK` on its values, so a fourth status is one entry in the list and no migration (SQLite cannot alter a `CHECK`). The `CHECK` that is there only guards the rule that a row is never empty. The note is capped at 500 characters: it is a reminder, not a document, and the cap bounds the tooltip, the menu and the answer.

Measured on a temporary file with this repo's `better-sqlite3` (50,000 marks, a fifth with a 200-character note; not the real database): reading 2,000 hosts in one `IN (...)` takes 4.2 ms (500 hosts 1.1 ms, 20 hosts 0.06 ms); one upsert 0.01 ms (WAL, `synchronous = NORMAL`). The largest `IN` list this build accepts is 32,766 variables, far above the 2,000 sites a list may hold (`SITE_COUNTS_MAX_PER_LIST`), so a read needs no chunking. The request for 2,000 hosts is 50 KB; the answer is 173 KB for 1,000 marks, and about 1.3 MB at the very worst (2,000 marks, each with a 500-character note).

## Interfaces

`/api/lookup/marks` (`app/api/lookup/marks/route.ts`), session only, with the auth of `/api/lookup/counts`: any signed-in user, admin or analyst, like the page. It is not on `/api/v1`: nothing asked for it, and an API key has no person to attribute a mark to.

- `POST { hosts: string[] }` reads the marks of those hosts, once per count. `200 { success, marks: { [host]: { status, note, updated_by, updated_at } } }`, only for hosts that have one (`status` or `note` is null when unset). 400 for a body that is not JSON, no hosts, more than 2,000 or a non-string; 401 without a session.
- `PUT { host, status?, note? }` changes one site. A field left out keeps its stored value and `null` clears it (the monitors' `PUT` also updates only the fields it is sent); a note is trimmed and an empty one is `null`; when neither is left the row is deleted, and deleting what is not there succeeds. `200 { success, host, mark }` carries the stored state after the write (`mark` is null when none is left), and the page shows that, not its own guess. 400 for a body that is not JSON, a host the rules above refuse, a status outside the list, a note that is not a string or is over 500 characters, or neither field; 401; 500 (logged with `console.error`: the production build strips `console.log`).

A save sends only what the person changed, so two people changing one site, one the status and one the note, both survive; two changing the same field leave the last one's.

`updated_at` is returned as SQLite stores it and the page formats it with `formatRelativeTime` (`lib/format-relative-time.ts`), whose comment explains why a bare `new Date()` on that string is wrong by the offset of the machine's timezone.

## The page

**The cell.** 48 px between the site name and Rows, at every width. It holds the icon of the status and a small dot on it when there is a note. Its tooltip reads the label, the note (first 200 characters), then who and when. The header above it is `Mark`, a sort header like the number columns. By arithmetic from the measured widths in the site-counts design, the name column goes from 372 to 312 px at 1440 px and from 212 to 152 px at 1280 px; the build measures it again at 1440, 1280, 1100 and 375 px.

**The menu** (the `Popover` in `components/ui`), opened by the cell:

- four buttons, No mark, Done, Skip and To look at, the current one pressed; a click saves at once and closes the menu. The clearing one is called "No mark", not "Clear", which the list panel already uses for the pasted list;
- a note box (500 characters, a counter near the limit), saved when the menu closes if its text changed: by a click away, by Esc, or by Ctrl+Enter, which closes it. A mark button saves an unsaved note in the same request, so nothing typed is lost;
- who set it and when.

**Loading and saving.** The marks of the whole list (`planSites(sites).hosts`, the cleaning the counts use) are asked for once when a count starts, alongside its first request, so a row arrives with its mark. Until the answer a cell shows a loading dot and cannot be clicked. If the request fails the cell shows a muted warning icon ("Marks could not be loaded"), the chips and the sort are off, and a notice with a Retry says so. A mark that could not be loaded is never shown as "No mark": that would let someone save over a note they cannot see. A change shows at once and is replaced by the server's answer; if the save fails the cell goes back and a toast says it was not saved; an expired session says what the counts say. The changes to one site go one after the other, so a late answer cannot overwrite a later click. Counting again asks again; the list's "Clear" and a new file do not touch the stored marks.

**Filter.** Chips above the table with their counts: All, Done, Skip, To look at, No mark (a site that can be marked and has no status). The badges and "rows in all" keep describing the whole count. A filtered table says "Showing 37 of 400" with a way back, and a filter that matches nothing says so and offers "Show all". The filter, like the sort, is a way of looking at the rows, so counting again keeps it. A row leaves the table at once when a change takes it out of the filter: filtering to No mark and working down the list is the point. A row that cannot show a mark appears under All only.

**Sort.** The `Mark` header, first click: To look at, then No mark, then Done, then Skip; the second click reverses it and the third goes back to the default order; sites that tie keep the default order. A row that cannot show a mark (no host, or marks not loaded) goes last whichever way, never as "No mark", as a site with no number goes last in the number columns. `SiteSortKey` gains `'mark'` and `orderSiteRows` takes the mark of a row as a third argument. The ranking, the filter test and the chips' counts are pure functions in a new `lib/site-marks-input.ts`, which the page imports; `lib/site-marks.ts` imports `better-sqlite3`, which the page cannot.

**Export.** Export CSV follows the table on screen, as it already follows the sort: with a filter on it writes only the rows shown, and its label carries their number ("Export CSV (37)"). The file has no mark column.

**Two traps in the existing page.** The whole row header is one `<button>`, and a control inside it would be a button in a button: the header becomes a `div` that toggles the detail on a click, with the chevron as a real `<button aria-expanded>` for the keyboard and for assistive tools. And the menu renders in a portal, but React bubbles a click in a portal to the row's handler, which would open the detail: the cell's wrapper stops the click.

## Failure behaviour

| What goes wrong | What the person sees |
|---|---|
| the marks do not load | counts show as always; cells show the warning icon; chips and sort are off; a notice with Retry |
| a save fails | the cell goes back to what it was; a toast says the mark was not saved |
| the session has expired | the message the counts give: sign in again |
| two people change one site | each sends only what they changed; the answer replaces what the page shows; no live refresh before the next count |
| a note over 500 characters | the box stops at 500; the route answers 400 if that is bypassed |
| a row has no host | no control on it |

## Proof (how it will be shown)

Tests written first and seen failing, then green:

- the store on a real SQLite file, the way `__tests__/monitor-views-upsert.test.ts` does it: status only, note only, both; a field left out keeps its value; `null` clears; both empty deletes; the `CHECK` refuses an empty row;
- both verbs of the route: 401, every 400, the round trip, a write seen by the next read;
- the pure functions: ranking, filter, chips' counts, the unknown-last rule;
- the page's source checks, in the repo's style.

About a dozen mutations, each of which a test must catch: an emptied row kept; a field left out read as `null`; no status check; no note cap; a host not required to be unchanged by the cleaning; no session check; the sort ranks flipped; an unloaded row ranked as "No mark"; the "No mark" count including rows that cannot be marked; a failed load treated as "No mark"; an export that ignores the filter; a click in the menu opening the row; no per-site queue. The CI gate runs the typecheck of the app, `scripts/` and `__tests__/`, then tests, lint and build.

The rehearsal, on the built candidate image and the isolated stack, as a new step of `scripts/e2e-batch-lookup.ts` (it already has the stack, the login and a seeded site): mark a seeded site, count it again typed three ways and see the mark each time, add a note, then recreate only the app, keeping its data volume as `scripts/e2e-disk-gate.ts` does, and read the mark and the note back. Then the page in the browser pane on the stack that `--keep` leaves running, as the earlier pages were checked (seeded rows, a real login, real key events, slow and failed states made by overriding `fetch`): the four states of a cell, the menu, the note, the filter and the sort both ways, a failed load, a failed save, a click in the menu not opening the row, and no overflow at 1440, 1280, 1100 and 375 px.

## Not done

- A mark column in the CSV: offered, not chosen. One more column and its header, if wanted.
- Statuses the owner defines (names, icons, colours): a settings screen and rules for renaming or deleting a status in use. The list in code takes a fourth status in one line.
- A mark per person; a history of changes (only the last one is kept); marks on `/api/v1`; marks on other pages (Credentials, Batch Lookup, monitors). The table is keyed by host, so they could read it.
- Marking several sites at once; a filter by note.
- Automatic marks. The counts already say which sites have rows; a mark is a decision by a person.

## Decisions that are mine, open to change

The labels (Done, Skip, To look at); the sort order of the `Mark` header; Export CSV following the filter; a row leaving the table when a change takes it out of the filter; the 500-character cap; a mark button closing the menu; Esc saving the note; the marks of the whole list asked for once per count; a failed load disabling the cells.

## Rollout (planned)

Local only, on the owner's machine, as the earlier releases. Check first that no import is running and `inbox/processing` is empty. Tag the running image (`docker tag ulp-suite-app:latest ulp-suite-app:rollback-<UTC time>`) before building anything; build the candidate under its own tag from `git archive <commit>`; rehearse it with `REHEARSAL_APP_IMAGE`; then move `latest` and run `docker compose up -d --no-deps --no-build app` from the primary checkout. No ClickHouse change and no new setting, so `docker-compose.yml` and `.env.example` stay as they are; the README's Site counts bullet gets a sentence. Rollback: move the rollback tag back and run the same `compose up`; the `site_marks` table stays in `ulp.db` and the image that ran before ignores it.
