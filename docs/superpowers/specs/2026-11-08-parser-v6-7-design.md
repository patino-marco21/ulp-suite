# Parser v6.7: a pipe where the colon behind the scheme belongs; four kinds of field that are no credential; a gate rule that mistook usernames for hosts — design and results (2026-11-08)

Date: 2026-11-08
Status: **Deployed on 2026-11-08 (image `3e27c3c13271`, rollback tag `rollback-20261108-0625z`); the re-read of the four files is done, see "Results".**
Related: `2026-11-07-parser-v6-6-design.md` (the parser this follows), `2026-10-12-source-archive-and-ingest-gate-design.md` (the quality gate), `2026-11-07-file-ledger-design.md` (the re-feed).
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

Two questions on the day after v6.6: is the parser as good as it can be on what it *stores*, and why are six files still waiting in the inbox's `held` folder?

**What the parser stores that it should not.** The survey of v6.6 ran the production per-line path over three 2 MiB slices of every archived file (745 files, 437 GiB, about 6 billion accepted lines;
counts weighted by file size) and looked at the stored lines that do not look like a credential. About 0.1% of the stored lines:

| Family | Share of stored lines | In the table |
|---|---|---|
| decrypt-error text in the password slot ("Decryption failed.", "Old or unknown version", "Unable to decrypt", "Can't decode", a version marker) | 0.04% | 1,228,588 rows |
| a login that is only two quote characters | 0.02% | 352,860 rows |
| a fragment of a JSON object in a field | 0.03% | not counted |
| an advert that starts with emoji, in the password | 0.006% | not counted |

The parser had a list of sentinel passwords, but it held `decryptionfailed.` and `old or unknown version.`; the tools write "Decryption failed." with a space and "Old or unknown version" without the full stop, so no line ever matched.

**Why files are held.** The gate's "junk" is a stored row that its own classifier calls broken, so a held file is one whose stored rows are broken. The reports of the held files said:

- Two re-fed dumps were held at 3.3% and 4.36% (limit 2%). The 4.36% was **one layout**: `https|//host/path|login|password`. A list that separates its fields with a pipe also wrote the pipe where the colon behind the
  scheme belongs. The parser stored the url `https`, the login `//host/path` and the password `login|password`: 1.84 million rows of that one dump are in the table that way (the gate called them "login has a slash").
  The exact scan of the archive: **3,229,539 lines in 4 files** (about 10 GiB), nowhere else.
- The 3.3% was **the gate**: in a `login:password` list without urls, a login with a dot (`name.surname`, a dotted number) was counted as "a host used as the login". No parser rule is at fault.
- Three files stay held for what they hold: one is mostly lines of a url and an e-mail address with no password, one has a third of its lines as plain text, one has sections of urls whose scheme lost its colon that the positional
  reader merged into rows. These are decisions about the files (Release or drop), not about the parser.

## The rules

**S: a pipe where the colon behind the scheme belongs** (`joinSchemeWordPipe` in `lib/ulp-recover.ts`, applied at the start of `parseLine`). A line that starts with `http` or `https`, an optional colon, a pipe and two slashes has its scheme put back:
`https|//host/path|login|password` is read as `https://host/path|login|password`, which the pipe rules read as url|login|password (a pipe in the password stays in it). The same line with colons behind the url is read the same way.
`https|host|login|password` (no slashes) and other scheme words are not touched.

**Four rejections** (`lib/ulp-field-junk.ts`, applied in rule 3.7 of `parseLine` and in `isJunkCredential`, so the block and positional readers get them too):

1. the password is the text a stealer tool writes when it could not decrypt (a closed list, compared case-insensitively with white space collapsed, and only for values of at most 24 characters);
2. the login has no letter and no digit in any script (two quote characters, question marks that replaced the characters of a name);
3. a field is a fragment of a JSON object or array (`{"`, `["`, or `"value","key":"` at the start of a field: a line cut at its first colon);
4. the password starts with two or more emoji and has white space in it (an advert; a single emoji, or emoji with no space, is a password).

**The gate** (`lib/ingest-quality-gate.ts`): "login is a bare host" now needs the last label to be two letters (a country code) or one of a short list of common generic domains. `name.surname` and `1.2.3-4` are logins.

## Decisions

- Rule S can add rows from a file an older parser imported (the corrected row is a new credential), so **`PARSER_REVISION` is 67**; the four rejections and the gate change only remove rows or change the report. The wrong rows already stored (url `https`) stay: their repair is the owner's call, as every repair of stored rows has been.
- The held files that are held for their content stay held. Tuning the gate for single files would hide the next file of that kind.
- Not built: `https|host|…` (no slashes; 95 lines in the whole archive), a colon-less scheme in a positional record, and the diffuse rest of "login has a slash" (10 million lines in 580 files, no shape above 1% of it).

## Tests

`__tests__/ulp-parser-v6-7.test.ts` (38 tests: rule S in the line, stream and text paths, the shapes it must not touch, the four rejections and what they must keep — a passphrase, `{Admin123}`, a single emoji, a login in any script —, linear time on hostile fields, the differential classes),
`__tests__/ingest-quality-gate.test.ts` (dotted logins), `scripts/e2e-novelty-ingest.ts` scenario `v67` on a real ClickHouse. `scripts/parser-diff.ts` knows the classes `scheme-pipe` and `field-junk`.

## Results

**Proof.**
- Full suite 5,310 passed (38 new tests, 9 for the gate rule), typecheck of the app, `scripts/` and `__tests__/` and lint clean.
- Rehearsal on the candidate image against a real ClickHouse: the alert stack 51 of 51 checks, the ingest scenarios `basic`, `v6`, `v65`, `v66`, `v67` 49 of 49.
- Differential against the committed v6.6 over 251 archived files (about 2.5 billion lines, sampled): field-junk 1.98 M lines would no longer be stored, **unexplained 0**. (That run did not use `--same-policy`, so it also lists the T3 keep-list difference as `t3-kept`; every line is in a class.)
  The sampled third misses rule S, as the survey did: the layout sits in a part of 4 files.
- Exact check of rule S on those 4 files (3,229,538 lines that start with a web scheme word and a pipe, the committed parser against the working tree): the old parser stored 2,555,271 of them as url `https` and a login that starts with `//`;
  the new one stores 1,953,921 correctly (1,887,219 distinct credentials) and drops 598,659 (the country policy and the four rejections: the old rows ignored both because their fields were wrong); in the fourth file 654,978 of the lines read the same as before.
- The importer's own sample check (`scripts/preflight.ts`) on the held files, before and after: the 4.36% dump passes at 0.21% junk; the 3.30% dump passes at 0.38% (the gate rule); the file with the colon-less scheme sections stays at 6.10%, the two files of urls with an e-mail and no password and of plain text stay held at 46.99% and 13.65% unsplit.

**Deploy.** Image `3e27c3c13271` replaced `30447d3b320d` at 2026-11-08 07:14:57 UTC (the revision timeline step); the app is healthy and the log is clean.

**Re-read.** The three files that carry rule S and the dump that was held (12.3 GiB, 4 files) were read again from the archive, 07:16 to 07:47 UTC: 4 done, none held or failed, **2,429,338 new rows**
(1,613,631 and 803,673 from the two dumps, 6,437 and 5,597 from the other two: their corrected rows were nearly all in the table already). The table went from 2,792,234,249 to 2,794,663,587 rows, exactly the new rows.

**Left alone.** The wrong rows already in the table (url `https`, login `//host/…`: about 1.84 million from one dump) and the 1,228,588 decrypt-error and 352,860 quote-login rows: repairing stored rows is the owner's call.
