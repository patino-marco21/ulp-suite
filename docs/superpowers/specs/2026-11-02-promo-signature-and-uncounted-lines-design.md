# Parser v6.3: a promotional signature at the end of a line, and records that were opened and never finished — design and results (2026-11-02)

Date: 2026-11-02
Status: **Implemented and tested; real-data check, rehearsal and deploy are recorded under "Results" as they happen.**
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
