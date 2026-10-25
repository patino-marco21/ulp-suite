# Parser v6.2 and a quality gate that ignores noise: design and results (2026-10-24)

Status: **implemented on 2026-10-24** (branch worktree-ingest-layout-fixes); tests, the real-data differential and the whole-file verdicts are below. Deployment, the
rehearsal and the re-feed of the eight files are recorded at the end under "Rollout". The owner asked what "Held by the quality gate (8 files)" means and what to do
about it, was shown the diagnosis and the plan, and answered "Yes" to the parser rules (step 1), the gate changes (step 2) and the re-feed (step 3). Every number comes
from the importer's own parser and counters run read-only over the held files, from the archived pile, or from the live table. No source file names, search terms or
credential values appear here on purpose: the repository is public until the owner makes it private. The files are called family A to D.

## What the owner saw, and what it means

The Inbox card read: "These files were stopped before one row was stored: too many of their rows look wrongly split." The owner's model was that the parser keeps the
quality lines and drops the rest. It does, for every line it **rejects**. The gate exists for the rows the parser **accepts but splits wrongly** (a login that is a url,
a password that holds a link): no line-level rule can drop those, because the parser believes they are good. The gate counts them while the file is staged and stops the
file before one row reaches `ulp.credentials`. Eight files were held since 2026-10-17; every re-feed held them again with the same numbers. None was safe to Release.

## Why each file was held (before)

| Family | Files | Size | Lines | Held on | What was really wrong |
|---|---|---|---|---|---|
| A | 5 | 127 to 217 MB each | 14.34M together | 5.8 to 5.9% unsplit (limit 5%) | **Two things.** 61% of the unsplit lines are a seller's repeating advert and divider block (no credential in them, correctly dropped) and 39% are `:https://host:port:token` lines with one field: not a credential either. The real defect was one the gate could not see: about 96% of all lines start with `:https://`, a colon before the scheme. The parser kept it: `url` = ":https://..." so `url_scheme` is empty and `url_host` is the whole url, and the content key (it strips only `^https?://`) differs from the same credential stored without the colon. 93.5 to 94.3% of the sampled credentials were already in the table, so a Release would have stored about 10.8M duplicates in disguise. |
| B | 1 | 1.43 GB | 17.56M | final check, after 95 minutes: 4.44% of the stored rows (625k of 14.07M) break a rule | 89% of those are `login-has-slash`: a url that carries another url in its query (`?next=https://...`) was cut at the inner `https:`, the login became `//host/...` and the real login and password ended up in the password. The early check (first 1.12M lines) saw 0.26% and passed; a 5-slice sample saw 3.8% in seconds. Found later, by the differential: about 45% of this file's lines (7.4M of 16.3M, extrapolated) also start with the colon of family A, which the gate's rules cannot see. |
| C | 1 | 9.7 MB | 154k | 9.49% of the stored rows (12k) | layout `host/\|Label:login:Label:password`, no scheme: login = "host/", password = "Label:...". `joinPipedUrl` (v6.1) needs a scheme. |
| D | 1 | 11.7 MB | 187k | 47.5% of the stored rows (76k of 167k) | layout `login;password:url`: the url stayed at the end of the password. The colon form `login:pass:url` was handled, the `;` form was not. |

## Parser v6.2: four rules

All four are new functions in `lib/ulp-recover.ts` (the old helpers are untouched, so `scripts/parser-diff.ts`, which runs the baseline parser against the working-tree
helpers, stays valid) plus small hooks in `lib/ulp-parser.ts`. Examples are synthetic.

- **J, a colon in front of the scheme.** `:https://host.example.test/path:alice:Secret1` has an empty first field; `stripLeadingColonBeforeScheme` drops the colons
  (`/^:+(?=[a-z][a-z0-9+.-]{0,31}:\/\/)/i`, linear) in `parseLine` and `parseInlineLine`. A line with no scheme behind the colons is not touched.
- **K, the url last behind a semicolon.** `alice;Secret1:https://host.example.test/login` (and `alice;Secret1;https://host.example.test:8443/login`):
  `splitSemicolonPasswordUrl`. The url is what follows the last `:http(s)` or `;http(s)`; it must be a host, an optional port and an optional path; the login is the text
  in front of the first `;` and holds no space, slash or colon; the password is everything between that `;` and the url (it may hold `:`, `;` and `/`). It runs only where
  the old `;` branch would have taken the line (rule I of v6.1, "a `;` behind a complete credential is part of the password", is unchanged and goes first).
- **L, a labelled pair behind a pipe.** `host.example.test/|Username:alice:Password:Secret1`: `splitPipedLabelledPair`. The head is a url or a bare host with a path, the
  first label behind the pipe is one of login/username/user/email/e-mail/mail, the first `:Password:` (or Pass/Pwd) separates the login from the password. It is looked at
  before the pipe is taken for a join or a separator.
- **M, a url inside a url.** `https://sso.example.test/x?next=https://app.example.test/y:alice:Secret1`: `indexOfFieldColon` skips a `:` that opens `//` and the port of
  that inner host, so the inner `https:` no longer ends the url. A url without an inner scheme is split exactly as before. A line with a url inside a url and only ONE
  token behind it is now rejected (`no_fields`) instead of being stored as a login `//app.example.test/y`.

## The gate: lines that cannot hold a credential are not "unsplit"

`cannotHoldCredential(line)` (`lib/ulp-recover.ts`) is true for a rejected line that cannot be a credential in any layout the parser knows: a banner or a divider (no field
separator and a symbol or emoji in it, or nothing but punctuation), a bare url, or a url or host/path with at most one field behind it (`https://host:8443:token`,
`https://host/login?next=https://other/home:token`). It is false for anything that could be a credential the parser failed to split: plain text, a line with an e-mail
address, two or more separators behind the url, any line with a separator that does not start with a url. Lines over 4,096 characters count as possible credentials.

`parseULPStream` counts the `no_fields` lines for which it is true in `StreamBatch.noCredential` (they stay in `breakdown.no_fields`; the positional-url path counts too).
`evaluateGate` computes the unsplit share as `(noFields - noCredential) / lines` for the hold test, the warn test and the reasons, clamped at zero. The report carries
`noCredential`; a report written before has none. The reason now reads "N% of the lines could not be split into a login and a password (limit L%)".

## The gate: a sample check before a big file is staged

`sampleHold(source, config)` in `lib/ingest-preflight.ts`, called by `importThroughStage` before `registerStage`/`createStage`:

- only for a file over 8 MiB (`PREFLIGHT_WHOLE_FILE_MAX`; the importer sees every line of a smaller one in seconds) and only in `hold` mode;
- it reads the preflight's slices (5 evenly spaced slices of 2 MiB, the first at the start and the last at the end), runs them through the importer's own parser and
  counters, and holds only when the sample is past a hold limit by **1.5 times** (`SAMPLE_HOLD_MARGIN`): slices are an estimate, and the early and final checks still see
  everything. The report has `phase: 'sample'` and the real limits in the reasons;
- a released file (`gateOverride`) skips it; a file with no source (a ZIP entry, an HTTP stream) goes to the early and final checks alone; a sample that cannot be read
  returns null with a `console.warn` and never fails an import;
- `ImportHooks.sampleSource` carries the `Source` (`processTextFile` opens the file with `fileSource`, `processArchiveRef` passes the archive source). No new setting.

Cost: about 1.1 to 1.4 s per big file (measured on all eight held files).

## The Held card

`app/inbox/page.tsx`: the header now says that a file is held either because too many lines could not be read as a login and a password or because too many of the rows
that were read break the rules of a clean row (a login that is a link, a password that holds a link), that Release imports it once with its rows as they were read, and
that a layout the parser does not know yet is better fixed in the parser first. Each file shows the shares with their meaning, how many unsplit lines were left out
because they carry no credential, and for `phase: 'sample'` that the numbers come from slices across the file.

## Verification

**Tests.** `__tests__/ulp-parser-v6-2.test.ts` (rules J to M, `cannotHoldCredential`, the stream counts), the gate (`ingest-quality-gate`: noise exclusion, clamp, report,
sample phase), the preflight (`sampleHold`: small file, margin, modes, never throws, banners and bare urls), the importer (`upload-processor-gate`: fake big source holds
before a stage exists, skips for a released file / warn / off / no source; `upload-processor-novelty` and `upload-processor-archive-ref`: a real file and an archived file
past 8 MiB are held by the sample), `parser-diff` (the four change classes and the old-only row signatures) and `ulp-recover-linear-time` (every new helper on runs of
400,000 characters). The full suite: **261 files and 4,162 tests pass** (10 files are the live-database tests, skipped).

**Real-data differential (`scripts/parser-diff.ts`, baseline 6c5e4a3, `--same-policy`).** 33 archived files (every 17th name, 169M lines, extrapolated): 0 unexplained. The
classes: leading colon 2.87M lines, url last behind a semicolon 2k, url inside a url 10k (the others are the earlier classes, none changed). The stream comparison of
whole files (rows only the old parser stores) over the seven held files under 300 MB: every old-only row belongs to a class. Family A: all but about 0.01% of them (the
double-encoded text that parser v6 already explains) are rows whose url, or login, starts with the colon, replaced by the same credential without it (1.65M to 2.83M rows per
file). Family C: 11,757 of 11,760 are labelled-pair junk. Family D: 77,208 of 77,212 are url-last junk; per line, 62,089 stored rows became a different (clean) row and
15,100 stored rows became rejections, 13,920 of them `tier_dropped`: the url is now correct, so the T3 policy sees the country and drops the row; the rest are 654 without a
password and 548 garbage. Family B (1.43 GB) is above the 300 MB stream cap and was compared by 8 slices of 4 MB: 0 unexplained; there 170k of 382k lines read as a
different row (the colon, and the url inside a url) and 12.9k stored rows became `no_fields` (a url inside a url with one token behind it: not a credential).

**Fuzz.** One-character runs of 200,000 characters between credential-like heads and tails (2,420 cases) and 2,000 random multi-unit lines through the new helpers,
`parseLine`, `parseInlineLine` and the stream parser: 0 above 250 ms; the slowest were 29 ms (`parseLine`) and 16 ms (`stripLeadingColonBeforeScheme`).

**Whole-file verdicts with the importer's own parser and counters (production defaults: hold at 2% junk / 5% unsplit / 25% garbage, warn at 1% / 2%).**

| Family | Lines | Stored | Junk before (A: a 5-slice sample; B to D: the whole file) | Junk now | Unsplit now | Garbage now | Early (1M lines) | Final | Sample check |
|---|---|---|---|---|---|---|---|---|---|
| A, file 1 | 2,108,604 | 1,663,441 | 0.7% | 0.08% | 0.67% | 2.16% | PASS | PASS | no hold |
| A, file 2 | 2,377,680 | 1,875,101 | 0.7% | 0.07% | 0.66% | 2.18% | PASS | PASS | no hold |
| A, file 3 | 2,745,199 | 2,164,081 | 0.7% | 0.07% | 0.67% | 2.18% | PASS | PASS | no hold |
| A, file 4 | 3,175,740 | 2,504,664 | 0.7% | 0.09% | 0.96% | 2.57% | PASS | PASS | no hold |
| A, file 5 | 3,604,684 | 2,843,034 | 0.7% | 0.07% | 0.67% | 2.17% | PASS | PASS | no hold |
| B | 17,561,775 | 13,591,389 | 4.44% | 0.17% | 0.57% | 3.68% | PASS (0.25% / 1.54%) | PASS | no hold |
| C | 154,137 | 126,584 | 9.49% | 0.21% | 0.18% | 0.38% | n/a | PASS | n/a |
| D | 187,188 | 152,207 | 47.5% | **1.53%** | 1.96% | 0.73% | n/a | **WARN** | n/a |

Family D is the only one that is not a clean PASS: 2,336 of its stored rows (1.53%, over the 1% warn limit and under the 2% hold limit) still break a rule. The long tail is
`login;` followed by `:https://...` with no password (796 rows, 0.52%), `ip:port/` lines (662 as a bare-host login, 485 with a slash), JSON blobs in the password and a few
others. WARN imports the file and records the report on the job; it does not hold. A fifth rule for the tail (a `;` followed only by a url is "no password") is a small,
separate change if the owner wants those 2.3k rows kept out.

## Not done

- **Rows already in the table with a colon in front of the url.** The layout is not new to the pile: **25,589,633 rows** (1.15% of the table, from 174 source files,
  imported between July and October 2026) have a `url` that starts with a colon (25,537,822 of them `:https://...`); their `url_scheme` is empty and their `url_host` is the
  whole url. The earlier parser stored them that way. Rewriting them (strip the colon, recompute the materialized columns) is a data repair on a table of 2.2B rows and the
  owner's call; it would also make the content key of those rows equal to that of a clean copy. Until then a credential whose only copy in the table is a colon-led row is
  stored once more when a clean copy arrives; in the samples of family A the share was 0.5 to 1.8%.
- **Per-row quarantine** (keep the good rows of a file the gate stops, put the bad ones aside) stays in "Later specs" of the gate design.
- The gate still cannot see a wrongly split row whose fields all look plausible; that is what the differential against a baseline parser and the rehearsal are for.

## Rollout

(Filled in after the deployment: the rollback tag, the rehearsal result, the re-feed of the eight files and what the table holds afterwards.)
