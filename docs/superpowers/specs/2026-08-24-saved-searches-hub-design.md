# Saved Searches Hub — Design

## Problem

The live-matches feature shipped earlier today (`app/api/monitoring/monitors/[id]/matches/route.ts`,
the "View Matches" dialog in `app/monitoring/page.tsx`) is only reachable from inside
`/monitoring`, which is an admin-only page (`adminOnly: true` on the "Domains" sidebar
entry, [app-sidebar.tsx:56](../../../components/app-sidebar.tsx)) built around monitor
*configuration* — creating monitors, managing webhooks, reviewing alert history.

The user wants the results-consumption half of that — "see the credentials/entries as a
saved search" — promoted to its own first-class navigation destination that any
authenticated user can reach directly, without wading through admin config or caring
about webhooks at all. This mirrors the original ask this session started from.

## Scope

**In scope:**
- A new `/saved-searches` page and sidebar entry, in the "Search" group between
  Batch Lookup and Breaches.
- Lists active monitors as "saved searches" — name, domains, match mode, a cheap
  per-user last-viewed indicator.
- Clicking a search opens the existing live-matches dialog (extracted into a shared
  component so `/monitoring` and `/saved-searches` share one implementation).

**Out of scope (explicitly):**
- Monitor creation, editing, webhook management, alert history — stays in
  `/monitoring`, admin-only, unchanged.
- The monitor-rescan cron timing out 100% of the time for at least one existing
  monitor — real, confirmed, filed separately as a task chip
  (`task_14757f00`). Unrelated system (scheduled background job vs. this
  on-demand page), not touched by this design.
- The batch lookup issue the user flagged as a side note — pending repro details,
  tracked separately, not touched by this design.
- Renaming "monitors" to "saved searches" as a data model concept. They stay the
  same underlying `monitors` SQLite table and `DomainMonitor` type
  ([domain-monitor.ts:8](../../../lib/domain-monitor.ts)) — "Saved Searches" is UI
  framing on read-only data, not a new entity.

## Architecture

### New page: `app/saved-searches/page.tsx`

Client component, `useAuth(true)` gated (same as every other authenticated page —
no admin requirement). On mount, fetches `GET /api/monitoring/monitors?active_only=true`
and renders each monitor as a card: name, domain list (first few + count), match mode
badge, last-viewed indicator, "View Matches" button.

No create/edit/delete affordances here — this page is read-only by design (see Scope).
Empty state ("No saved searches yet — ask an admin to set one up in Domain Monitoring")
if the list is empty, matching how `/monitoring` already messages its own empty states.

Uses the endpoint's existing default `limit` (50) with no pagination UI — same
implicit cap `/monitoring`'s own monitor list already lives with today. Worth
revisiting only if a real deployment approaches that many monitors; not a v1 concern.

### Sidebar entry

[app-sidebar.tsx:36-44](../../../components/app-sidebar.tsx) — insert into the
existing `"Search"` group's `items` array, between Batch Lookup and Breaches:

```ts
{ title: "Saved Searches", url: "/saved-searches", icon: Bookmark },
```

No `adminOnly`. `Bookmark` (lucide-react, not currently imported in this file) reads
as "saved item" without colliding with `Search` (Batch Lookup), `ShieldAlert`
(Breaches), or `Radio` (Domains/Monitoring).

### Shared matches dialog

`openMatches`, its five pieces of state (`matchesMonitor`, `matches`, `matchesLoading`,
`matchesLimited`, `matchesNewCount`, `matchesError`), the request-sequencing guard
(`matchesRequestId` ref), and the Dialog JSX currently live inline in
[app/monitoring/page.tsx:97-252,1193+](../../../app/monitoring/page.tsx). Extract into:

- `hooks/useMonitorMatches.ts` — the state + `openMatches(monitor)` + `closeMatches()`,
  unchanged in behavior (same endpoint, same request-sequencing guard, same error
  copy). Pure lift-and-shift, not a rewrite.
- `components/monitor-matches-dialog.tsx` — the Dialog JSX (loading / error / empty /
  table branches), taking the hook's state as props.

`/monitoring` and `/saved-searches` both import the hook + component. `/monitoring`
keeps its own "View Matches" button calling the same `openMatches` — nothing removed
from the admin page, it just now shares the implementation instead of owning it.

### API change: `last_viewed_at` on the monitors list

[app/api/monitoring/monitors/route.ts](../../../app/api/monitoring/monitors/route.ts)'s
`GET` handler adds one field per monitor: `last_viewed_at`, from the already-existing
`getLastViewedAt(monitorId, userId)` ([domain-monitor.ts:480](../../../lib/domain-monitor.ts))
— one extra SQLite lookup per monitor in the response, not a ClickHouse call. Purely
additive to the response shape; `/monitoring`'s existing consumption of this endpoint
is unaffected since it just ignores the new field.

The saved-searches page renders this as "Never viewed" (null) or a relative time
("3 hours ago"). It is **not** a live match count and does not query ClickHouse —
that only happens when a specific search is opened, same as today. Rendering the list
does not call `recordMonitorViewed` — only opening a search's matches does (existing
behavior, unchanged), so merely looking at the hub never marks anything as viewed.

## Data flow

1. Page load → `GET /api/monitoring/monitors?active_only=true` → SQLite only,
   cheap, returns monitors + `last_viewed_at` per monitor for the requesting user.
2. Click a card → `openMatches(monitor)` → `GET /api/monitoring/monitors/[id]/matches`
   → the existing two-phase ClickHouse query, unchanged → dialog shows results,
   NEW badges, and (as a side effect, same as today) advances that user's
   `monitor_views` cursor for this monitor.
3. Next hub page load → that monitor's `last_viewed_at` reflects the view just recorded.

## Error handling

- Monitors list fetch fails: page-level error state ("Couldn't load saved searches"),
  matching the tone of existing page-level errors elsewhere in the app — not a toast,
  since it blocks the whole page's content.
- Matches dialog fails: unchanged — already handles both a JSON error response and a
  network failure, both explicitly telling the user "this is not a confirmation that
  nothing matches" (existing copy, carried over verbatim via the extraction).

## Testing

- `hooks/useMonitorMatches.ts` and `components/monitor-matches-dialog.tsx`: the
  existing `__tests__/monitor-matches-route.test.ts`-style coverage for the endpoint
  itself is untouched (route isn't changing). New/moved coverage should confirm the
  extraction preserved behavior — request-sequencing guard still discards stale
  responses, error copy unchanged — rather than re-testing the query logic itself.
- `GET /api/monitoring/monitors`: extend existing route tests to cover the new
  `last_viewed_at` field (null when never viewed, populated after a view, scoped
  per-user — two different users viewing the same monitor shouldn't affect each
  other's `last_viewed_at`).
- `app/saved-searches/page.tsx`: source-text-assertion style tests matching this
  session's convention for page-level components (see
  `__tests__/monitor-matches-route.test.ts` for the pattern) — sidebar entry present
  and correctly positioned, page renders cards from the monitors list, empty state
  when the list is empty, last-viewed indicator renders both states (never / relative
  time).

No live browser verification will be possible for the same environment reason as
earlier today — worktrees can't reach ClickHouse or log in. Same mitigation: careful
code reading, cross-checked by an independent reviewer, not click-through proof.
