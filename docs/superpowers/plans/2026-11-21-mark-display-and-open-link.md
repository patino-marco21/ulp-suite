# The Mark display and the open-site arrow — plan

> Design: `docs/superpowers/specs/2026-11-21-mark-display-and-open-link-design.md`. Four tasks, each ends in a commit with its tests green.

**Goal:** an open-site arrow beside every domain; the Mark readable at a glance (pill with the word, note line, edge in the status colour, whole note when
opened). **Architecture:** UI only. A pure `siteUrl`, one link component, and edits to the two components the rows are made of. **Tech:** Next 14, Tailwind 3.4,
lucide-react 0.454, vitest with `renderToStaticMarkup`.

## Task 1 — `siteUrl` and `SiteLink`

- Test first, `__tests__/site-url.test.ts`: `siteUrl('corp.example')` is `https://corp.example/`; a subdomain, an IP and a long host work; `''`, a host with a
  space, `a.com:99`, `a.com/path`, `a@b.com`, `a.com?x`, `a.com#x`, `javascript:alert(1)` and a scheme-prefixed value are `null` (a scheme is not a host: the
  caller passes the host the counts name, never the pasted text).
- `lib/site-url.ts`: `new URL(`https://${host}/`)` in a try; accept only when `protocol === 'https:'`, no user, password, port, search or hash and
  `pathname === '/'`.
- `components/site-link.tsx`: `<SiteLink host label? />` — an `<a>` with `href`, `target="_blank"`, `rel="noopener noreferrer"`,
  `referrerPolicy="no-referrer"`, `aria-label="Open {host} in a new tab"`, `title`, an `ArrowUpRight`; `onClick` stops propagation; renders `null` when
  `siteUrl` is `null`. With `label` it shows the text ("Open site") next to the arrow.
- Component tests in the same file: the attributes above, the stop of the click (source pin), `null` for a bad host.

## Task 2 — the pill and the editor (`components/site-mark-cell.tsx`)

- Tests first (`__tests__/site-mark-cell.test.ts`, rewritten where the old look is pinned): each status renders a pill with its word and its own icon and
  tint; "Note" for a note without a status; the "+ Mark" pill with hover/focus/touch visibility; no tint on "No mark"; the word is hidden below `sm` but the
  accessible name and the tooltip keep it; loading/failed unchanged; the editor header carries the host and "Open site"; the note box is taller; chosen
  choices tinted. Keep the tests for the save rules.
- Implement: `STATUS_STYLE` (pill, edge, chosen) as UI constants exported for the row; `MARK_CELL` becomes `w-12 sm:w-28 shrink-0 flex items-center justify-start`;
  the trigger renders the pill; the popover is `w-80`; `Textarea` `min-h-[7rem]`.

## Task 3 — the row (`components/site-count-row.tsx`)

- Tests first (`__tests__/site-count-row.test.ts`): the arrow follows the site text inside the same line and is an anchor (not a button, so the button depth
  stays 1 and the count of buttons is unchanged); no arrow for a row with no host; the note line appears with `line-clamp-2` and a speech-bubble icon when the
  mark has a note and not otherwise; the edge element carries the status colour and is absent without a status; a row with a note and no rows can be opened and
  shows the whole note (`whitespace-pre-wrap`) and who/when; the opened subdomain lines each carry an arrow; the row has `group/row`.
- Implement as the spec says; the unmarked pill is visible through `group-hover/row`.

## Task 4 — see it, then ship

- Run the whole suite, `tsc` (app, scripts, tests), lint, build.
- Build the candidate image, bring the rehearsal stack up with it, drive Site Counts and the Directory in the Browser pane (screens: light, dark, narrow;
  arrow opens a new tab and not the detail; edit a note; long note; the Directory rows), fix what only the browser shows.
- Merge to `main`, push, tag the running image, deploy locally, README line, memory.
