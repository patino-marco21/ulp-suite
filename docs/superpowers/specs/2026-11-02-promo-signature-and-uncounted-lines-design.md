# Parser v6.3: a promotional signature at the end of a line, and records that were opened and never finished — design and results (2026-11-02)

Date: 2026-11-02
Status: **Deployed on 2026-11-02 (main `c2f7183`) and the three affected files repaired the same day; see "Results".**
Related: `2026-11-01-near-duplicates-design.md` ("As deployed": the line count that found this), `2026-10-24-parser-v6-2-and-gate-noise-design.md` (the gate and the parser rules J to M this follows).
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

An independent newline count of the 81 files of the first large batch on the normalised key (961,158,676 lines) against what the jobs counted (945,845,618) found 15,313,058 lines (1.6%) that are in no counter: not stored, not rejected, and invisible to the quality gate, which counts what the parser reports. 70 files were within 0.1%. The other 11 were from one source family:

- Three files end every record line with a promotional signature (`<url>:<login>:<password> ┃ @channel words / more`: white space, a heavy vertical bar, an `@` handle and a few words, the same tail on all of 20,983,273 lines) and carry a blank CRLF line after every record. 13,455,774 of the gap is in them.
- The signed lines the field split could read stored the tail inside the password: 6,224,227 rows (22% of the family's rows, 7.2% of the batch). Earlier months hold 229 rows with the character, so older imports are not affected.
- The other eight files hold the remaining 1,857,284 lines: URL-to-URL lines with no credential in any layout. Harmless, but also in no counter.

## The mechanism

`parseULPStream` takes a line that starts with `http` and that the field split rejects (`no_fields`) for a bare URL and parks it: the next lines may be its login and its password (the label-free stealer-log layout). A blank line, a labeled line or the end of the file ends the wait, and the parked line was dropped there without a count (the comment said so: "discarded at separator/EOF"). A signed line is unsplittable, so it was parked, and the blank line after it dropped it. In one of the files 96% of the data lines went that way (a 1,000,000-line sample: 508,261 blank lines counted, 469,814 parked lines dropped, 17,381 credentials, 3,642 tier-dropped).

Two kinds of signed line existed: one the split refused (dropped), and one with a path in the URL that parsed with the tail in the password. The tail also hid rejections that the rules make for an unsigned line (a placeholder password, a login equal to its e-mail password, a one-character password, a `;` at the end of a password).

## Rules

**N: the signature is cut before the line is read** (`lib/ulp-promo-signature.ts`). The cut is the leftmost match of `/\s+┃\s*@[\s\S]*$/`: white space, U+2503, optional white space, an `@`, to the end of the line. It is found without a regex, with one `indexOf` per bar, so a long white-space run costs linear time (the regex form is quadratic; a test compares the two on every string of up to 8 characters over five symbols, 488,000 strings, and times a million-space line). Evidence for the narrow form: the strict rule matched every one of the 20,983,273 signed lines of the three files, with no leftover and no other bar character. It applies to every line kind the stream parser reads (inline, labeled, positional), to `parseULPContent`, to the preflight's second look at unsplit lines, and to the side-copy tool, so that all of them classify a line the way the importer does.

**Counting:** a parked record that a blank line, a labeled line or the end of the file closes is now a rejected line: `no_fields` for a URL alone (and `noCredential` when the URL cannot hold a credential, so the gate's unsplit share leaves it out, as for a bare URL), `no_password` for a URL with its login. The gate therefore sees credential-looking lines that the split cannot read even when a blank line follows each; a file of them is held, where it used to pass with no line counted.

**Empty files:** a file of 0 bytes (a failed copy leaves one) is recorded as `done` with the job note `empty-file` and listed as "empty file · nothing imported", not as an import that found nothing; nothing is staged, asked of ClickHouse or remembered for it. Five such files were recorded as `done`, 0 rows, no note, and the data they stood for was never imported.

## Decisions

- Only U+2503 and only with white space in front and an `@` behind it. A bar inside a password stays.
- The Latin-1 form of the bar (a line that is not valid UTF-8 as a whole stays Latin-1 in the parser) is not handled: none of the 20,983,273 signed lines was invalid UTF-8, and no stored row has that form.
- `parseBlockStream` is untouched: no signed block line was seen.
- The row repair of the three files is a separate step, below.

## Tests

- `__tests__/ulp-promo-signature.test.ts`: the cut, the cases that must not change, the exhaustive comparison with the regex, and linear time on million-character lines.
- `__tests__/ulp-parser-v6-3.test.ts`: four URL shapes of a signed line (no path, a path, a port, a login that is not an e-mail), the CRLF file with a blank line after every record, a labeled password, the counting of every way a parked record ends (stream and content parsers), a property test (300 random files with either line ending: credentials + rejected equals the number of lines, no password keeps the tail), pathological lines through the whole parser, and what the quality gate sees.
- `__tests__/import-summary.test.ts`, `__tests__/upload-processor-novelty.test.ts`, `__tests__/dropped-lines.test.ts`: the empty-file note and the side copy.
- Every new test was shown failing first; with the cut switched off the signature tests fail on all four URL shapes.
- Rehearsal scenario `v63` in `scripts/e2e-novelty-ingest.ts`: a CRLF file with signed and plain records and two bare URLs (4 rows new, 8 skipped, the passwords clean), and a 0-byte file dropped in the inbox.

## Results

**Real data, the old parser against the new one (2026-11-02, before the deploy).** The v6.2 parser (from git) and the v6.3 one ran on the same slices, six of 2 MiB per file as the preflight reads them, of all 121 files in `inbox/done` and `inbox/held` (686 slices, 25,072,561 lines), with the production tier policy.

- Slices without a signed line: the same credentials in every file. Nothing is stored by the old parser and not by the new one, or the other way round.
- Signed lines (13 slices of 3 files): 101,804 credentials stored before, 238,956 now. 74,766 of the old ones carried the tail in the password; none of the new ones does. 506 old credentials are not in the new output. Looked at line by line in the six slices of the worst file (216 of them), they are rejections that the rules make for an unsigned line and that the tail had hidden: 121 placeholder passwords, 87 logins equal to their e-mail password or one-character passwords, and 8 with a `;` at the end of the password that the old parser could not strip because the tail sat behind it. The 137,658 credentials that only the new parser stores are the lines it used to drop.
- Counters: rejected lines 7,336,611 before, 7,360,010 now: 23,399 lines that were in no counter are `no_fields`, 13,139 of them lines that cannot hold a credential, which the gate leaves out of the unsplit share.
- The quality gate's verdict, from the same slices: identical for all 121 files (115 pass, 5 warn, 1 hold before and after). The unsplit share of five files of the family rose by 0.5 to 1.3 points (the highest is 1.33%); none crossed the 2% warn limit. In a 2,000,000-line sample of one of them, 69,159 of the 80,259 newly counted lines cannot hold a credential (a URL followed by a URL) and 11,100 are credential-shaped lines that the split cannot read (a port where a login should be); the gate could not see those before.

**Rehearsal (isolated stack, candidate image built from the commit that holds the code).** The alert rehearsal passed 50 of 50 checks and the full end-to-end suite 249 of 249 (every scenario but the one that fills the disk, which this change does not touch), including the new `v63` scenario: the CRLF file with three signed records, one plain record and two bare URLs gave 4 new rows with clean passwords, the 8 other lines in the skipped count (so every line of the file is in a counter), and the 0-byte file dropped in the inbox was recorded as `done` with the note `empty-file`, with nothing staged or remembered for it. `npm run typecheck`, lint on the changed files and the whole unit suite (287 files, 4,799 tests) pass.

**Deploy (2026-11-02 07:00Z).** Main `c2f7183`, image `66bf5035a6b8` (the rehearsed candidate, tagged `latest`), rollback tag `rollback-20261102-0642z`. Nothing was importing; only the app container was recreated, ClickHouse kept running; healthy, 0 restarts, no migration to run.

**Repair of the three files (same day).**

1. The rows to remove were copied to a scratch table (6,224,227 rows, 257 MiB): the rows of the three files with the tail in the password, all in partition 202611. One mutation limited to that partition removed them: the table went from 2,692,240,818 to 2,686,016,591 rows, and the three files kept their 283,323 clean rows. The scratch table was dropped after the checks below.
2. The three `ulp.sources` entries were deleted, so that the same-name check did not skip the files, and the three files were moved from `done/` back into the inbox. Jobs 3105 to 3107 ran in 361 s on the normalised key:

| | file (12) | file (11) | file (13) |
|---|---|---|---|
| lines in the file | 21,728,874 | 34,444,781 | 22,461,910 |
| new | 41,361 | 8,925 | 40,461 |
| known | 8,687,478 | 13,696,568 | 8,839,899 |
| repeats inside the file | 66,850 | 109,054 | 150,243 |
| skipped (blank lines included) | 12,933,185 | 20,630,230 | 13,431,306 |
| counted in total | 21,728,874 | 34,444,777 | 22,461,909 |
| lines in no counter (before: 7,167,670, 771,915, 5,516,189) | 0 | 4 | 1 |

3. **The estimate was a ceiling.** The design above spoke of about 11.8M credentials missing "before the known check". The check cut that to 90,747 new rows: the cleaned credentials were almost all in the table already, held from other sources (of the 8,728,839 distinct credentials of file (12), 41,676 are stored under its own name). The polluted rows had only looked new because the tail made their keys unique. The net effect on the table is 6,224,227 rows removed and 90,747 added: 2,686,107,338 rows.
4. Checks. The 90,747 new rows have as many distinct normalised keys and as many distinct exact keys, and none of their keys appears twice in the table; no row of the three files holds the tail; no query failed; the peak of a query was 1.17 GiB and the server's 6.5 GiB (during the mutation). `scripts/pile/verify-file.ts` (an independent offline recount, `REIMPORT=1`, partition 202611) passed every check for all three files: the importable rows equal the ClickHouse hashing, skipped lines, repeats and the new-plus-known split equal the job, every distinct credential of the file is in the table, none is stored twice, and the source entry holds the delta.

**Left alone.** 63 older rows (two October files) carry a similar tail; they are 63 rows of 2.7 billion and their clean versions would need those two files re-fed. The five empty files need to be copied again by whoever holds them.

**Wider audit of the stored passwords (read-only, the same day, after the deploy).** The question was whether the same defect hides elsewhere in the table. Two full passes over the password column (about 3 minutes each, with a per-file count of signature-shaped endings: a handle, a link to a channel, a bar with spaces around it, symbols and emoji, a date and time) found, by indicator and not by hand-checked row, about 5.9 million rows (0.22% of the table) with a promotional or metadata ending or with an advertisement where the password should be, and about 1 million more whose password is a decryption-error text. Nothing was changed.

| shape | rows | imported | original still held |
|---|---|---|---|
| ` | <link to a channel>` at the end of the password, one file | 1,518,833 | August | no |
| a date, a time and `AM::` at the end, after extra colon-separated fields, one file | 3,670,424 | August | no |
| an advertisement in place of the password (a doubled emoji, then a bracket and words) | 478,096 | October | yes |
| white space, a handle and a dash with words at the end, seven files | 209,214 | July and August | no |

- The inflow has stopped. By the month of import, hits of the three indicators (a channel link, a handle, emoji in the password): July 204,000, August 1.9 million, October 500,000, and 3,500 in the November partition (118 million rows). The last batch brought almost none.
- The 1,518,833 rows with the link at the end have 1,518,345 distinct keys once the ending is cut, and only 420,485 of those keys (27.7%) are already in the table. Deleting them, which was right for the three files above (almost all of their clean credentials were already stored), would here lose about 1.1 million credentials that exist only in this form; they can only be corrected in place.
- Of the 231 files imported in July and August, 204 have no archived original and cannot be fed again; every October and November file is archived.
- The password-derived columns (`password_length`, `password_mask`, `password_entropy_band`, `content_key_hash`, `norm_key_hash`) are MATERIALIZED and `proj_imported_desc` holds the password, so a correcting `ALTER ... UPDATE` would recompute them and rebuild that projection. It has not been tried on this table; a scratch copy comes first.
