# Parser v6.5: a parenthesised copy of the site between the url and the credential — design and results (2026-11-06)

Date: 2026-11-06
Status: **Built on 2026-11-06; the differential, the rehearsal and the deploy are recorded under "Results" when they are done.**
Related: `2026-11-06-credential-first-url-design.md` (the parser v6.4 this follows), `2026-10-24-parser-v6-2-and-gate-noise-design.md`.
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

After the v6.4 batch, the rows that landed in the table were checked against the invariants a stored credential should hold. The 507,871 rows of the v6.4 re-feed were clean. The older rules' baseline was not, in one recognisable way: a login that is a parenthesised host and path, with a password of the shape `login:password`.

- The raw layout, masked: `host/path:(host/path):login:password`. A url, then a parenthesised copy of the site, then the credential. The colon chain takes the copy as the login and `login:password` as the password, so the stored row is wrong: login `(host/path)`, password `x:y`, and the credential that is really in the line is stored nowhere.
- 10,391 of 4,000,000 lines (0.26%) of one dump are stored that way. In the whole table (2.78 billion rows): 571,634 rows have a login wrapped in parentheses with a slash in it and a colon in the password, 487,041 of them (85%) repeat the url's host; 429,695 more are wrapped without a slash, 109,264 in square brackets, 1,106 in curly brackets. They come from 401 source files, the first from 2026-07-04, and 68,465 arrived with the batch of 2026-11-06 (0.18% of its rows).
- Over 10.8 million real lines (four files of different families), a bracket-wrapped login with a colon in the password splits into: the parenthesised text repeats the url's host 9,676 times (the clear family); a number or a country prefix in parentheses, `(123)` or `(+7)`, 4,748 times (an id or a phone prefix that could well be the login); anything else 223 times (a slash that is not the host) and 92 times (square or curly brackets).

## The rule

**P: the copy is an annotation** (`splitSiteAnnotation` in `lib/ulp-recover.ts`, applied in `parseLine` after the fields are split and before every policy). When the login is wrapped in `(` and `)` and the text inside repeats the host of the url (case does not matter, a leading `www.` is ignored), and the password holds a colon with something on both sides, the login is the part of the password before its first colon and the password the rest. A colon in the password stays in the password (`alice:pa:ss1` gives `alice` and `pa:ss1`).

- The host is the part of the url between its scheme and the first `/`, `?`, `#`, `:` or `@`; it must have a dot and at least three characters, so a url that is not a host (`login`) never matches.
- The copy is at most 2,048 characters and the host at most 253: the work is one search of a short string in a short string, linear in the line.
- Every policy after the split still applies to the new login and password: a placeholder login is garbage, a password under three characters is dropped, a hard-dropped tier is dropped (the tier follows the new login).

## Decisions

- Only parentheses, and only when the text repeats the host. A number or a country prefix in parentheses (`(123)`, `(+7)`) could be the login, and so could text that is not the host; square and curly brackets are rare (92 lines in 10.8 million). They are left as they were. The 864,340 stored rows with a parenthesised login and no colon in the password are a different thing and were not classified.
- The rule is not the last fallback: it works on the fields the earlier splits produced, so a line that parsed to a login without brackets parses the same.
- Repairing the roughly 0.5 million stored rows that match the rule (delete and re-feed from the archive, 401 files) is a live-table rewrite and stays the owner's call; the corrected credentials may be new or already known.

## Tests

- `__tests__/ulp-parser-site-annotation.test.ts` (40 tests): eight accepted forms of the function (a path, a scheme, `www.` in the url only, upper case, a port, an e-mail login, a colon in the password, the host alone), fifteen forms that stay as they were (a number, a country prefix, text that is not the host, another host, square and curly brackets, mismatched brackets, no closing bracket, no colon in the password, nothing before or after it, no url, a url that is not a host, a login that is not wrapped, an empty copy), the same in whole lines, the policies after the split, `parseULPStream`, and six degenerate lines of 300,000 characters that must parse in under 1.5 s. Every test was shown failing first: without the production change 29 of the 40 fail.
- `__tests__/parser-diff.test.ts`: the change class `site-annotation` for a changed row, for a row now dropped by a policy after the split, and for a row only the baseline stores in stream mode; a change that is not what the rule gives, and a parenthesised number, stay unexplained.
- Fuzz for linear time (as after the 2026-10-12 incident): 21 repeated units × 6 heads × 6 tails × 3 positions (2,268 cases) timed at 20,000 and 80,000 repeats through `parseLine` and `parseInlineLine`; nothing flagged, the slowest 52 ms at 80,000 repeats.
- Rehearsal scenario `v65` in `scripts/e2e-novelty-ingest.ts`: three lines with a copy of the site (no scheme; a scheme with `www.` only in the url and an e-mail login; a colon in the password) and three that stay as they were; expected 6 rows new, the fields as built, no row whose login is a parenthesised host.

## Results

**Real data, the v6.4 parser (from git, commit `205da06`) against the working tree (2026-11-06, before the deploy).** `scripts/parser-diff.ts --whole --lines-with '('` over eight whole files (the five dumps of the batch, the 3.4 GB dump, the 347 MB file and the 81 MB file), 2.2M lines holding a parenthesis: 139,431 lines changed in the class `site-annotation` and 44 in `t3-kept` (the old parser dropped the line by the country of the url's host because the login it saw was the parenthesised copy; with the real e-mail login the line is stored, which is the tier policy applied to the right field); unexplained 0. A first run with the filter `':('` read nearly every line (the option takes a set of characters) and was stopped after 40 minutes.

**Rehearsal (isolated stack, candidate image built from the commits).** The alert rehearsal passed 50 of 50 checks and the novelty-ingest scenarios (every one but the disk filler) 322 of 322, including `v65`: six rows new, the three copies read as annotations with the fields after them, the three other shapes stored as before, no row whose login is a parenthesised host. The quality-gate scenario also proves the hold report's unsplit shapes (31 of 31): a file where 1 line in 9 cannot be split is held and its report lists one shape of 3,000 lines with the words shown as `w` and no value of the file anywhere in it.
