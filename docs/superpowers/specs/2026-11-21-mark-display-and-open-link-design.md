# The Mark display and the open-site arrow

Status: designed with the owner on 2026-11-21 (mock-up and three answers, below); built in `feat/mark-display`. It extends the marks of
`2026-10-29-site-marks-design.md` and the rows shared by Site Counts and the Site Directory (`2026-11-21-site-directory-design.md`). No server,
database or API change: this is the display of data that is already stored.

## What was asked

1. Beside every domain, an arrow or something clickable that opens the site in another tab.
2. Make the Mark easier to read: its status and its comment ("note") should be visible without hovering or opening anything.

## What the data says

The 66 marks on the live machine: 64 carry a note. The 55 "Skip" marks all have one (average 102 characters, longest 500, which is the limit), the 5
"To look at" marks all have one (average 43), 4 of the 6 "Done" marks have one (average 16). So the note is most of a mark, and today it is a 6 px dot
in the corner of a 16 px icon, with the text in a hover tooltip or inside the menu. The status is an icon only: colour and shape, no word.

## Design (the owner chose the recommended option on all three questions that mattered)

### The arrow

- A small `ArrowUpRight` link right after the domain text, on every row of Site Counts and of the Site Directory, and after each subdomain in an
  opened row, and as an "Open site" link in the mark editor's header. Always visible (muted, darker on hover): a touch screen has no hover.
- `target="_blank"`, `rel="noopener noreferrer"`, `referrerPolicy="no-referrer"`: the opened site is not told which app it was opened from.
- The link goes to `https://<host>/`, the front page of the site the counts name. It does **not** carry the path, query or credentials of what was pasted:
  the counts drop the path of an entry anyway, and a pasted line can have a login and a password in its path or query, which opening the page would send to
  the site. (`https` is assumed; a site that only answers on `http` shows the browser's own error.)
- No link where there is no site: a row whose entry is not a site address, or a host `new URL` does not take as a plain host.
- The click does not open the row's detail (it stops there), and the link is a real anchor, so middle-click, copy-link and keyboard Enter work.

`siteUrl(host)` is a pure function (`lib/site-url.ts`): it builds the URL, parses it, and returns `href` only when the parse left a plain `https` origin
(no user, password, port, path, query or fragment); otherwise `null`.

### The Mark in the row

- The 48 px icon cell becomes a **pill** with the word: Done (green), Skip (red), To look at (blue), each with its icon, tinted for light and dark.
  A note without a status is a neutral pill "Note". Below the `sm` width the pill is its icon only (the word is in its accessible name and tooltip).
- A site with no mark shows a dashed "+ Mark" pill on row hover and keyboard focus, and always on a touch screen (what the faint outline did).
- The **note is a line under the domain**, with a speech-bubble icon, clamped to **two lines**. A longer note ends in an ellipsis.
- A marked row has a 4 px **edge** in the status colour on its left (an inner bar clipped by the row's rounded corners), so a long list can be scanned.
- The pill is still the one button that opens the editor, still stops the click from opening the row, and keeps its tooltip and accessible name
  (`markTitle`, `markAriaLabel`) — the tooltip stays as the quick full read.

### The editor (what the pill opens)

Wider (320 px), the note box taller (about 7 lines), the four choices tinted in their own colour when chosen, "Open site" in the header next to
the host. The save rules do not change: saved when it closes, Ctrl/Cmd+Enter closes it, a status button saves an unsaved note with it.

### The opened row

A row with a mark that has a note can be opened even when it has no rows, and its detail starts with the **whole note** (line breaks kept) and who set
it and when. The Site Directory's rows were already always openable.

### Not changed

The server, the mark API, the store, the sort by Mark, the chips above the table, the order of the Directory. The Directory search stays on the domain
only (the owner declined searching inside notes).

## Files

- New: `lib/site-url.ts`, `components/site-link.tsx`.
- Changed: `components/site-mark-cell.tsx` (pill, tints, editor), `components/site-count-row.tsx` (arrow, note line, edge, whole note, group hover),
  `lib/site-marks-input.ts` (the tint classes are UI and live in the component; this file only keeps `markTitle` and friends as they are).
- Tests: `__tests__/site-url.test.ts` (new), `site-mark-cell.test.ts`, `site-count-row.test.ts`, `site-directory-page.test.ts` (the page keeps using the
  row; one pin if the row's markup it reads changed).

## Verification

Unit tests render the markup (as the existing ones do). Because a class string is not a look, the built page is also driven in the Browser pane on the
rehearsal stack (`docker-compose.rehearsal.yml`): rows with each status and a long note, light and dark, a narrow window, the arrow opening a new tab and
not the row's detail, the editor saving a note, and the Directory page with the same rows. Deploy follows the usual convention (rollback tag, candidate
image, rehearsal, then `compose` from the primary checkout).
