# Hardening bundle — design (2026-10-03)

Status: **designed, not built.** Companion to `2026-10-03-domain-search-dictionary-design.md` (the search speed-up, built first). Every
finding below was checked against the code and the running app on 2026-10-03; nothing here touches ClickHouse data.

## What is wrong

The app renders and exports data that comes from other people's leaks, so anything an attacker can plant in a credential line (a URL, an
email, a password) reaches the owner's screen, clipboard and spreadsheets. A review of 2026-10-03 found six small gaps, none urgent while the
app is bound to 127.0.0.1 with one account, all cheap to close:

| # | Finding | Evidence |
|---|---|---|
| H1 | **The CSV export has no formula-injection guard.** A password, URL or email that starts with `=`, `+`, `-` or `@` is a live formula when the file is opened in Excel or Sheets (`=HYPERLINK(...)`, DDE payloads, or just a mangled value such as `=abc123`). Leak dumps are attacker-controlled input, so this is the classic CSV-injection path. | `app/api/export/route.ts:206`: `csvEscape` only doubles quotes. The other formats (json, ndjson, ulp, userpass, wordlist, spray, hcmask) are machine formats, not spreadsheets. |
| H2 | **The Content-Security-Policy is weaker than it needs to be and the server announces its framework.** `script-src` keeps `'unsafe-eval'` (a production Next.js build does not need it), `connect-src` allows `https://cdn.jsdelivr.net` that no code uses, and `X-Powered-By: Next.js` is sent. | `next.config.mjs:97`; live `curl -I http://127.0.0.1:3000/login`; `grep -rn jsdelivr app components lib` finds only the CSP line. |
| H3 | **The HIBP breach description is rendered as raw HTML.** Descriptions come from the Have I Been Pwned sync (a third party) and from the breach edit API. | `app/breaches/[name]/page.tsx:238`, `dangerouslySetInnerHTML={{ __html: breach.description }}`; sources `app/api/breaches/sync/route.ts`, `app/api/breaches/route.ts`. With `script-src 'unsafe-inline'` an injected tag would run. |
| H4 | **CI never builds the app and nothing proposes dependency updates.** CI runs `npm ci`, typecheck, test and lint; `next build` has only ever run inside the Docker build. The repo is public with Dependabot alerts and security updates disabled (owner-only toggles). | `.github/workflows/ci.yml` (4 steps); `.github/` holds one file; GitHub API on 2026-10-03. |
| H5 | **28 packages are behind their own version ranges** (no major bumps): `next` 15.5.24 to 15.5.27, `react` and `react-dom` 19.2.6 to 19.3.0, 13 `@radix-ui/*`, `better-sqlite3` 12.10.0 to 12.11.1, `@typescript-eslint/*` 8.60 to 8.71, `tsx`, `postcss`, `otpauth`, `yauzl`, `p-limit`, `@types/*`. `npm audit` reports 0 vulnerabilities today. | `npm outdated --json` on 2026-10-03: 39 outdated, 28 behind the range, 15 new majors (not touched here). |
| H6 | **Small hygiene.** `MEMORY_GUARD_MAX_WAIT_MS` and `MEMORY_GUARD_THRESHOLD_RATIO` are read by the code and documented nowhere; `.claude/` is untracked (`launch.json` is the dev-server config, `settings.local.json` holds the owner's local command permissions and must never be committed); `styles/globals.css` and the five `public/placeholder*` files were found unreferenced on 2026-10-01 and 2026-10-02. | `git status`; `grep` of `lib app` for the two variables; `app/layout.tsx` imports `app/globals.css`. |

## Goals

1. A CSV export opened in a spreadsheet can never execute or mangle a cell because of its first character.
2. A markup string from a third party can never run script in the app, and the CSP says only what the app needs.
3. A build failure is caught by CI, not by the next Docker build; dependency drift is visible as small pull requests.
4. The 28 in-range updates land with the whole test suite, a production build and the two rehearsals green, then deploy locally behind a rollback tag.
5. No change to any data, any API response shape (except the CSV bytes in H1), or any ClickHouse object.

## Design

### H1 — CSV cell guard (`lib/csv-safe.ts`)

`csvCell(value)` returns the quoted CSV cell: `String(value)`, then **if its first character is `=`, `+`, `-`, `@`, TAB or CR, a single
quote is prepended** (the OWASP CSV-injection mitigation), then quotes doubled and the cell wrapped in double quotes. The `csv` branch of
`POST /api/export` uses it for all 16 columns. Nothing else changes: json, ndjson, ulp, userpass and the streaming formats keep their bytes.
A numeric-looking value such as `-12345` also gets the quote (a spreadsheet would otherwise turn it into a number or a formula; analysts who
want it raw use ulp or json). `POST /api/export` takes an optional `csv_guard: false` for scripts that need the old bytes.

### H2 — headers (`next.config.mjs`)

`poweredByHeader: false`. In the CSP, drop `'unsafe-eval'` from `script-src` and `https://cdn.jsdelivr.net` from `connect-src`. `'unsafe-inline'`
stays (Next injects inline bootstrap scripts; a nonce-based CSP needs dynamic rendering for every page and is a separate project). The change
is only kept if a real browser, driving every page against the production build with the CSP enforced, logs no violation; if a page does need
eval, that page's cause is fixed or `'unsafe-eval'` stays and the finding is recorded as accepted.

### H3 — safe description rendering (`lib/safe-html.ts`)

A pure function `parseSafeHtml(input): SafeNode[]` (no DOM, no dependency; the test environment is plain Node). It scans tags with a small
state machine and keeps only `a` (`href` restricted to `http:`, `https:`, `mailto:`; the page adds `rel="noopener noreferrer"` and
`target="_blank"`), `b`, `strong`, `i`, `em`, `br` and `p`. Every other tag is dropped, its text kept; every attribute except `href` is dropped;
the common entities (`&amp; &lt; &gt; &quot; &#39; &nbsp;`) are decoded; input is capped at 20,000 characters. The breach page maps the nodes to
React elements, so no string is ever assigned to `innerHTML`.

### H4 — CI and Dependabot

`.github/workflows/ci.yml` gains `- run: npm run build` (with `NEXT_TELEMETRY_DISABLED: 1`) after lint. The Dockerfile already builds without
secrets, so CI needs none. `.github/dependabot.yml`: npm, weekly, **minor and patch updates grouped into one pull request**, at most 5 open,
`semver-major` ignored for `next`, `react`, `react-dom`, `tailwindcss`, `eslint`, `zod`, `typescript`, `vitest`, `better-sqlite3` and the
`@types/*` of those (a major is an owner decision, see "Deliberately NOT done"); github-actions, monthly. Dependabot *version updates* work from
this file alone; the repository's Dependabot alerts and security-updates toggles stay the owner's.

### H5 — in-range dependency refresh

On a branch: `npm update` (stays inside every `package.json` range), then `npm ci` from the new lockfile, typecheck, the full test suite, lint,
`next build`, and the two isolated rehearsals (`scripts/e2e-alert-rehearsal.ts`, `scripts/e2e-upload-resilience.ts`) against the freshly built
app image. Only if all pass: tag the running image as the rollback (`ulp-suite-app:rollback-<date>`), rebuild, recreate only `ulpsuite_app`.
`better-sqlite3` is a native addon: the Docker build compiles it from source, and the rehearsal's SQLite-backed paths cover it.

### H6 — hygiene

`.env.example` and the README environment table document the two memory-guard variables (meaning and default read from `lib/`). `.gitignore`
gets `.claude/settings.local.json`; `.claude/launch.json` is committed. `styles/globals.css` and `public/placeholder*` are re-checked with `grep`
and a production build, then deleted.

## Verification plan

- Unit tests: `csvCell` (each trigger character, leading space, embedded quotes and newlines, empty value, Unicode); `parseSafeHtml` (script and
  iframe tags, `onerror=`, `javascript:` and `data:` hrefs, unclosed and nested tags, entity edge cases, a 1 MB input); a source pin that the
  CSV branch calls `csvCell` and that `dangerouslySetInnerHTML` is gone from `app/breaches`.
- H2: `next build` of the production image on the rehearsal stack, then every page opened in the in-app browser with the console watched for CSP
  violations; `curl -I` shows no `X-Powered-By` and the new CSP.
- H4: the CI run on the branch is green with the new step; `dependabot.yml` is validated by GitHub's parser on push.
- H5: the full suite (135 files, 1931 tests today) plus both rehearsals green on the new lockfile; the live container healthy after the swap
  (`/api/auth/check-users` 200, log with no error or warn), the rollback tag present.

## Decisions for the owner (defaults in bold)

1. CSV cells that start with `= + - @` get a leading quote in the `csv` export: **yes** (opt-out parameter `csv_guard: false`), or leave the bytes alone.
2. Dependabot pull requests: **weekly, grouped minor and patch, at most 5 open**, or none (then H5 stays a manual job).
3. Drop `'unsafe-eval'` from the CSP: **yes if the browser pass is clean**.

## Deliberately NOT done

- **`system.text_log` TTL** (1.42 GiB, about 30 MiB a day). Adding it to `docker/clickhouse/config/ulp-system-logs.xml` makes ClickHouse rename the
  existing log table aside and recreate it, and a bad config file crash-looped the server in the 2026-10-01 near miss; not worth the risk for this size.
- **A nonce-based CSP** (dynamic rendering of every page), **major upgrades** (Next 16, Tailwind 4, ESLint 10, Zod 4, TypeScript 7, vitest 5,
  better-sqlite3 13 and 9 more), **the stuck third-party GitHub app check suites, Dependabot alerts, secret scanning, 2FA** (all owner-only), and
  **another ClickHouse container on the same laptop** (not part of this repo, published on 0.0.0.0:8123/9000; not probed).
- **HSTS on a plain-HTTP loopback origin** is ignored by browsers there and correct if the app is ever put behind TLS; left as is.
