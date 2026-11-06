# Parser v6.4: `login:password url`, the credential first and the url last — design and results (2026-11-06)

Date: 2026-11-06
Status: **Deployed on 2026-11-06 (main `69d434a`, image `a2fcde9668b6`); the held file imported on its own the same day; see "Results".**
Related: `2026-11-02-promo-signature-and-uncounted-lines-design.md` (the parser v6.3 this follows), `2026-10-12-source-archive-and-ingest-gate-design.md` (the quality gate whose early window this changes in effect), `2026-11-05-known-share-preflight-design.md`.
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

A batch of five dumps of 4.18 GB each went through the inbox with the parse pool on. Four imported (+31,426,220 rows, 15.6% of their valid rows new). One was held by the quality gate's early window: 41.23% of its first 1,326,587 lines unsplit, against a limit of 5%.

- The parser read `url login:password` (the url first, one space) and rejected `login:password url` (the credential first, one space). The two shapes are mirror images; every credential-first line was rejected cleanly as `no_fields` and none was misread as something else.
- Counted exactly over the whole files (two space-separated tokens, the first with a colon and no scheme, the second starting with a scheme): 2,384,129 of 57,979,508 lines (4.11%) in an imported file, which is 82% of the 2,915,675 lines the gate counted as having no fields, and 1,370,744 of 59,498,855 lines (2.30%) in the held file. Two older dumps hold 3 such lines each, so their own unsplit lines have another cause (not measured here).
- The shape sits in regions of the files where several source lists were joined: 61.5% of the first 4M lines of the held file and 6 to 16% of four later 4M blocks; in the imported file 66.5% and 88.6% of two blocks and 0 to 1.8% of the rest. So the early window (the first million lines) overstated the file: 41% in the window, 2.30% over the whole file.
- A Release of the held file would have imported what the parser reads and lost the 1.37M lines that it does not, which is the pattern the 2026-10-17 note warns about. The owner chose to write the rule instead.

## The mechanism

`colonSplit` in `lib/ulp-parser.ts` is a chain of fallbacks, each tried only when the earlier ones found no fields (space-padded colons, the colon fields, a slash in the password, a numeric login, a url and a credential separated by a space). The new rule is one more link, last in the chain, so a line that parsed before parses the same. Its result goes through every policy that follows the split: the placeholder logins, the password length, `login == password`, the tiers and the hard-drop countries.

## Rules

**O: login, password, one or more spaces, the url** (`splitCredentialUrlPair` in `lib/ulp-recover.ts`). The line must match `/^([^\s:/]+):(\S+) +(https?:\/\/\S+)$/i`, read as url, login, password:

- The login holds no white space, no colon and no `/`. The first colon ends it, as in a plain `login:password` line, so a colon inside the password stays in the password. A login with a `/` is a path (`host/path:value`), not a login.
- The password is one token (no white space). A password with a space in it, or a word between the password and the url, is not this shape and stays rejected.
- The url starts with `http://` or `https://` (any case) and holds no white space. Another scheme (`ftp://`) stays rejected: the url-first rule reads the same two.
- A Telegram link is never the url (`hasTelegramLink`), so a label in front of a channel link (`Login: https://t.me/...`) stays rejected, and the tag stripper still cuts such a link before any split, as before.
- An empty login, an empty password and a line of only a login stay rejected.

The regex has one unbounded run per group and no nesting; the test file times six degenerate lines of 300,000 characters, and the fuzz run below covers the combinations around it.

## Decisions

- Only the fallback position: a line that any earlier rule reads is read by that rule, so nothing that is stored today changes.
- Only `http` and `https`, the same two schemes the url-first rule accepts. A third scheme would be a separate decision with its own measurement.
- The android-style `...==@host/:` shapes and the `url:(+9) 9...` shapes that also sit in these files are not touched.
- Not a change to the gate: the early window stays at one million lines. With the rule in place most of what filled the held file's window is read, so it passes on its own; the measured result is under "Results". A Release was not needed and was not used.

## Tests

- `__tests__/ulp-parser-credential-url-pair.test.ts` (30 tests): nine accepted shapes (a path, no path, https, a port, an e-mail login, several spaces, CRLF, a colon in the password, a url inside a url), the domain, nine shapes that stay rejected, the Telegram cases, the layouts that must not move, the policies after the split (a placeholder login is garbage, a hard-dropped tier is dropped), both file parsers, and six degenerate-line timing guards. Every test was shown failing first; two expectations of mine were wrong at that stage and were corrected before the rule was written.
- `__tests__/parser-diff.test.ts`: the new change class `credential-url` for the three shapes, a line whose stored result differs stays `unexplained`, and shapes outside the rule stay `unexplained`.
- Fuzz for linear time, as after the 2026-10-12 incident: 19 repeated units × 6 heads × 5 tails × 3 positions (1,710 cases) timed at 20,000 and 80,000 repeats; nothing flagged.
- Rehearsal scenario `v64` in `scripts/e2e-novelty-ingest.ts`: three credential-first lines, the url-first mirror, five lines that stay rejected and two layouts that must not move. Expected and found: 6 rows new, 5 skipped, the fields as built, no row with a slash in the login, a Telegram link as the url or a space in a field.

## Results

**Real data, the v6.3 parser (from git `HEAD`) against the working tree (2026-11-06, before the deploy).** `scripts/parser-diff.ts --whole --lines-with ' '` over three whole files (the held file, an imported file that holds the shape, and a control without it), 10.8M lines with a space: 2,834,488 lines changed, every one in the class `credential-url`; unexplained 0. No line that parsed before parses differently.

**Rehearsal (isolated stack, candidate image built from the working tree).** The alert rehearsal passed 50 of 50 checks and the scenarios `v64`, `basic` and `workers` 45 of 45 (the parse worker's bundle carries the rule too). One earlier run showed 3 failures in `v64`; the cause was the procedure, not the code: the end-to-end script recreates the app through compose, and without `REHEARSAL_APP_IMAGE` exported for that step it fell back to the previous `:latest`. The rerun, with the candidate named for both steps, passed.

**Deploy (2026-11-06 18:38Z).** Main `69d434a` (CI green: typecheck, test, lint, build), image `a2fcde9668b6` (the rehearsed candidate, tagged `latest`), rollback tag `rollback-20261106-1825z`. Nothing was importing; only the app container was recreated, ClickHouse kept running; healthy, 0 restarts, no migration.

**The held file (same day).** Put back into the inbox with no Release at 18:41Z. The early window and the final check both passed (the job stores no gate report: neither warn nor hold), and it finished at 18:52Z, 10.7 minutes for the one 4.18 GB file: 6,006,457 rows new, 38,020,282 known, 11,616,590 skipped. `ulp.credentials` grew from 2,773,307,671 to 2,779,314,128 rows, exactly the 6,006,457 imported. Before the rule the same file had been held with 41.23% of its first 1,326,587 lines unsplit.

**The imported file with the same shape, re-fed (same day).** Its content was copied under a new name into the inbox (a same-name check keys on the name and the content hash, so the copy goes through the normal novelty check) at 18:53Z and finished at 19:01Z (8.2 minutes): 507,871 rows new, 44,330,879 known, 11,359,918 skipped. The skipped lines fell from 13,154,093 to 11,359,918, so the rule read 1,794,175 of the file's 2,384,129 credential-first lines; the other 589,954 fail a rule that follows the split (a placeholder login, a short password and the like). 28% of the lines the rule read were new, higher than the 15.6% the batch's other lines gave. `ulp.credentials` grew from 2,779,314,128 to 2,779,821,999 rows, exactly the 507,871 imported. The file's earlier verdict, warn at 4.66% unsplit, became no report at all. The batch's total is +31,426,220 + 6,006,457 + 507,871 = +37,940,548 rows.

