# Parser v6, three speed fixes and a T3 keep-list: design and the redo of the pile import (2026-10-12)

Status: **implemented on 2026-10-12** (branch parser-v6, merged to main; last code commit 435ec3e); **not yet deployed, the redo waits for run 4 and the
owner's go.** The owner approved this design ("Go"); the measured outcome of the build is in "Results" at the end. Written after a review of what the parser
still gets wrong, requested by the owner before the 140 GiB of original files are touched. Every number in the sections before "Results" comes from a
read-only survey of the pile (a sample of 4.5 GiB, 76.7M lines, taken
as 2 MiB slices from all 504 files and extrapolated by file size; accuracy a few percent) and from the live table. No source file names, search terms or
credential values appear here on purpose: the repository is public until the owner makes it private.

## Decisions taken in the owner interview (2026-10-11 / 12)

| # | Decision |
|---|---|
| 1 | **Full redo after run 4.** Run 4 (parser 624b845) finishes untouched. Then the new image is deployed, partition `202610` is dropped and the whole pile is imported again with the final parser. |
| 2 | **Originals stay** until the redo is verified. Then a compressed side copy of everything the parser drops is made, and only then may the owner delete them (nobody else does). |
| 3 | **T3: keep the wealthy countries only** ("wealth rule"): the 15 T3 countries with GDP per capita (PPP) of at least $40k. |
| 4 | **`login == password` is accepted when the login is not an e-mail address.** E-mail == password, and passwords under 3 characters, stay rejected. |
| 5 | **Android lines that lost their `android://` prefix are recovered, one row per login+password per file.** |
| 6 | **A slash in a password is recovered for e-mail logins and for other logins, with a filter against URL fragments.** |
| 7 | The 20 pile files whose names are already in `ulp.sources` and the one new download are part of the redo. |
| 8 | In-range dependency refresh (hardening Task 8) goes into the same image. Majors stay put. No Dependabot file. |
| 9 | Build flow: this spec, then the owner's review, then a plan, then a TDD build in a separate worktree. The redo starts as soon as the build is proven, in the daytime too, with a warning before the ~30 s restart. |
| 10 | Search targets: domain and e-mail/username must be fast (a login-only search scope is added after the redo); a one-word keyword may take up to 30 s. CSV exports up to ~1M rows (separate project). |

## What the review found

The pile is **2.39 billion** non-blank lines (63 B per line). What the parser does with them today:

| Outcome | Lines | Share |
|---|---|---|
| accepted | 1,865M | 78.05% |
| dropped by the T3 hard drop | 413M | 17.28% |
| rejected as garbage | 65.0M | 2.72% |
| rejected, password missing / too short / equal to the login | 23.7M | 0.99% |
| rejected, no fields | 21.3M | 0.89% |
| comment-like (`#`, `[`, `//`) | 1.8M | 0.07% |

### Credentials the parser rejects today and v6 recovers (what-if on the sample, pile-wide rows)

| Class | Shape (masked) | Matched | Recovered | Note |
|---|---|---|---|---|
| A. space-padded colons, no scheme | `host.tld : user@mail.tld : Secret1` | 17.9M | 16.2M (+1.3M T3) | the 2-part form is also a crypto-banner shape (`BTC : <emoji>`), so it needs an e-mail login |
| B. Android app id without `android://` | `HASH==@com.pkg.name/:user@mail.tld:Secret1` | 9.4M | 8.8M | mostly one account repeated across many app ids |
| C1. slash in the password, e-mail login | `https://host:user@mail.tld:Pa/ss1` | 1.9M | 1.7M | |
| C2. slash in the password, other login | `https://host:user:Pa/ss1` | 4.2M | 2.4M | 1.4M stay rejected by the garbage rules; part of the 2.4M are URL fragments, hence the filter |
| D. numeric login read as a port | `https://host:48213:Secret1` | 1.0M | 0.7M | 98% of the sampled numbers are not common web ports |
| E. protocol-relative `//host/...` | `//host.tld/path:user:Secret1` | 1.4M | 1.1M | the parser takes `//` for a comment |
| UTF-8 lines rejected as "mojibake" | non-Latin login or url | | 1.8M (+1.4M T3) | see below |
| **Total of A-E and UTF-8** | | | **up to ~32.7M, +1.75% of today's accepted rows** (before the per-file Android dedup and the URL-fragment filter, which lower it) | |

### Rows the parser stores wrongly today

**UTF-8 is decoded as Latin-1.** The stream parsers decode the bytes with `Buffer.toString('latin1')` so that nothing can throw, and the insert
re-encodes the string as UTF-8. Every UTF-8 multi-byte character in a line therefore turns into two or three characters of mojibake. All **13.2M**
lines of the pile that hold a byte of 0x80 or more are valid UTF-8 (0 are not), so the decode is lossless the other way round.

- ~2.0M accepted rows (0.11%) are stored with double-encoded text, mostly passwords. Confirmed in the live table by the signature
  `[\xC2-\xEF][\x80-\xBF]` read as code points: 0.113% of the new partition, 0.092% of July, 0.151% of August (~1.6M rows in the old partitions).
- 1.8M valid lines with a non-Latin login or url are rejected by the mojibake gate, because the gate cannot tell a mis-decoded line from a real one.
- Side effects of the same decode: a non-breaking space at the end of a field leaves a stray `Â` after `trim()`, and a byte-order mark at the start of
  a file garbles its first line.

**Junk rows that remain after all earlier fixes:** 530 per million stored rows (garbled lines, label forms, control characters). Accepted, as agreed
on 2026-10-11.

### Looked at and not worth doing

- **Better dedup keys.** Ignoring the url path, `www.`, port and e-mail case in the content key would merge only **2.7%** of the rows of the new
  partition (e-mail case alone: 0.23%), measured on a 7.1M-row sample grouped by lower-cased e-mail. A new key means recomputing 1.4 billion stored
  hashes for consistency. Not done.
- **`url::password` (empty login)** ~2.5M lines, **bare `t.me` links** 1.0M, **banners and adverts** (`W_W_W...`): not credentials, correctly rejected.
- **Placeholder logins** (`None`, `UNKNOWN`, `false`...) 17.7M and **sentinel passwords**: correct rejections.

## Parser v6 rules

All changes are in `lib/ulp-parser.ts` (+ one new module `lib/ulp-utf8.ts`). Every rule is a **fallback** tried only after the existing logic found
no fields, or a narrow pre-step that cannot touch a line that parses today, except rules 1 and 7, which change values on purpose.

**1. UTF-8 first (`lib/ulp-utf8.ts`).** In the two stream parsers (`parseULPStream`, the only one the importer calls, and `parseBlockStream`), a line whose text holds a character in U+0080-U+00FF is converted back to its bytes (`Buffer.from(line, 'latin1')`)
and decoded with a strict decoder (`new TextDecoder('utf-8', { fatal: true })`). If that succeeds the decoded text replaces the line; if it throws
the Latin-1 text stays. Only 0.55% of the lines pay for it. `parseLine`, `parseULPContent` and `parseBlockContent` are **not** changed: they take strings that may already be real Unicode
(`lib/legacy-repair.ts` passes stored rows to `parseLine`). The mojibake gate stays for lines that are not valid UTF-8. A real U+FFFD in the source is still caught by the binary check.

**2. Space-padded colons without a scheme (A).** A trimmed line without `://`, `\t`, `;` or `|` that splits on `\s+:\s+` into exactly three parts
`host : login : password`, where the host holds a dot or a slash and neither of the first two parts holds white space, is re-joined with bare colons
and parsed as usual. Two parts (`login : password`) are accepted only when the login is an e-mail address. The with-scheme variant already works.

**3. Android app ids without the scheme (B).** A trimmed line that starts with a base64url run of 16 or more characters, `==@`, a reverse-DNS package
name and `/:` (also with a leading `//`) gets `android://` (or `android:`) put in front of it and is parsed as usual, so the stored url looks like
the ones of the lines that kept their prefix. Recovered rows are deduplicated **per file on (login, password)**; the repeats count as `dedup`. Lines that
kept their `android://` prefix are unchanged.

**4. A slash in the password (C).** Before the generic "first slash ends the url" step: `scheme://host[:port]:login:password` where the host holds no
`@`, the login holds no `/` or `:` and the part after the second colon holds a `/`. The url is `scheme://host[:port]`, the password is everything
after the second colon. A password that looks like a URL fragment is not accepted: it holds `://`, starts with `www.`, starts with a host name
followed by `/`, holds a query string (`?x=`), ends in a web file extension (`.php`, `.asp`, `.aspx`, `.html`, `.htm`, `.jsp`, `.cgi`) or holds three
or more slashes. A line like `https://host/path:login:pass` is not touched (its first `/` comes right after the host).

**5. A numeric login that looks like a port (D).** `scheme://host:NNNNN:password` (1-5 digits, at most 65535, no further colon) is read as
login `NNNNN` unless the number is a common web port (80, 443, 8080, 8443 and the other ~50 on a fixed list). Today the line has only two fields
left after the "port" and is rejected.

**6. Protocol-relative urls (E).** A line that starts with `//` (not `///`) and has the shape `//host[/path]:login:password` is parsed as
`https:` + line; a trailing `:http` or `:https` (a scheme moved to the end by some export tools) is cut first; the URL-fragment filter of rule 4
applies to the password. Real comments (`// text`) have white space after the slashes and stay comments.

**7. `login == password` (policy).** Rejected only when the login is an e-mail address (it contains `@`). `admin:admin`-style pairs are stored. The block
format (`flushBlockState`) follows the same rule. The minimum password length of 3 is unchanged.

**What stays rejected on purpose:** lines with no login, `url::password`, a url with a single value, bare links, banners, placeholder logins, sentinel
passwords, passwords of 1-2 characters, e-mail equal to its password, and the slash-in-password lines the garbage rules or the URL-fragment filter refuse.

## Parser v6.1 (added the same night, before the redo)

Run 4 finished (397.5M rows) and its own residual check, a colon in the login or `://` in both url and login, found 842,706 junk rows (0.21%). The driver
session traced most of them to the pipe rule and suggested a fix. I reproduced the classes on the pile files (a read-only survey of every pipe and
semicolon line, masked) and found the semicolon rule does the same kind of damage in two more places that the signature does not see. Five narrow
rewrites, all in `lib/ulp-recover.ts` (pure helpers) and called from `parseLine` / `parseInlineLine`; none touches a line that parses correctly today
(the "unchanged" tests pin the layouts next to each one):

**F. Only the scheme in front of a pipe** (`https://| host:login:password`, 267k lines, nearly all from one file): the pipe was read as the login/password
separator, so the login became `https://` and the password the whole credential. The scheme and the text behind the pipe are joined (`https://host:login:password`);
when what follows is an e-mail address or a bare word the scheme is dropped.

**G. A one-word label and a colon in front of a pipe** (`Network:| host:login:password`, 169k lines, one label in one file): the label is dropped and the rest is
parsed as an ordinary line. It needs a credential-like piece behind the pipe.

**H. A url, then the pipe, then `login:password`** (`url:| login:pass`, `url |:login:pass`, `url|login:pass`, 235k lines): the url and the credential are joined by a colon.
The url is a scheme url, or a bare host followed by a colon before the pipe (without that colon `john.smith|pa:ss` is a login and a password and stays one). The part
behind the pipe is `login:password` with no slash or white space in the login and not the start of `scheme://`.

F, G and H act only where the old code read the pipe as the separator (no tab or semicolon in the line, fewer than two colons in front of the pipe, no e-mail
address and colon in front of it), so `url:login:pass|note`, `alice@mail.test:Secret1 | Country: US`, `url|login|pass` and `login|pass` are untouched. `parseInlineLine`
applies the join before the Android rule, so a label in front of `HASH==@com.app/:login:pass` still gets its `android://` back.

**I. A `;` behind a complete credential belongs to the password** (`https://host:alice@mail.test:Sec;ret1`, 1.32M lines): when the text in front of the first `;`
already holds a credential (two or more colons that are not part of `://`, or an e-mail address and a colon), the line is split on its colons and the semicolons stay in the
password; semicolons at the very end are a delimiter and go. Before, `url;login;password` with the whole credential as the "url" or the login stored junk
or lost the line (the driver's class 6c, 125k rows, plus the 3-part variant its signature misses). 76% of the tails behind the first `;` hold punctuation, i.e. look like
password characters; 10% are empty (a trailing `;`), 8% are a Telegram link the tag rule already cuts.

**J. A `;name=value` path parameter in a url without a scheme** (`host/app;jsessionid=AB12:alice:Secret1`): the existing rule covered `https://host/app;jsessionid=...`;
the scheme-less form stored `host/app` as the login and `jsessionid=...:alice:Secret1` as the password. The parameters must be followed by the colon that starts
the credential (`host/login;user=alice;Secret1` stays `url;login;password`). This class is much bigger than the 17k rows the driver counted, because its junk has no
colon in the login: 3.0M stored rows of run 4 have a `/` in the login, most of them this one.

**Measured (2026-10-12, before the redo).**

*Exact differential* (`scripts/parser-diff.ts --baseline-ref HEAD --same-policy --whole --lines-with '|;'`: the committed v6 parser against the working tree, same T3
keep-list on both sides, every line of every one of the 504 files that holds a pipe or a semicolon, the only lines these rules can touch; the examples are masked).
**3,720,781,452 lines read, 14,548,519 examined, 2,902,050 changed, unexplained 0.** A change is "explained" only when the new result is exactly what the committed
parser gives for the same line with the pipe joined, or with its semicolons made inert, so a rule cannot hide an unrelated change:

| Rule | Changed lines | New rows (rejected before) | Rows gone (junk, or the real credential is T3 / too short) | Row rewritten (junk -> the credential) |
|---|---|---|---|---|
| J. `;name=value` path parameter, no scheme | 1,215,177 | 95 | 419,232 | 795,850 |
| I. `;` behind a complete credential | 1,059,250 | 452,970 | 120,955 | 485,325 |
| F. only the scheme in front of a pipe | 267,621 | 199 | 42,141 | 225,281 |
| H. url, pipe, `login:password` | 190,605 | 7,317 | 49,869 | 133,419 |
| G. one-word label and a pipe | 167,924 | 2,502 | 20,666 | 144,756 |
| an Android app id behind a label or with a semicolon in the password | 1,473 | 1,305 | 4 | 164 |

Together: 464,388 credentials the importer used to lose are stored, 1,784,795 junk rows become the credential they were (url, login and password in the right fields),
652,867 junk rows are not stored any more (most of them because the credential is now seen for what it is and the T3 policy or a password under 3 characters rejects it),
net **-188,479 rows** over the pile. A strict regression probe (the old row had an e-mail login, a clean url and no semicolon in it; up to 25 examples per file collected, 100 in all) found three kinds of
line and no regression: lines whose old row was an e-mail-looking fragment of the password (the new row has the real login), the lines of one account export (a JSON blob,
then `email;first name;last name;id;token`: the old "password" was a name and a token, and the line is rejected now), and `file://|login|password` lines whose useless
url `file://` is empty now.

*Residual junk* (sampled slices of every file, 2.36B lines weighted, the same detector on the old and the new parser): stored rows that look like junk fall from 6.86M (0.349% of
the stored rows) to 4.45M (0.226%); the clearly-junk kinds (a login that is a scheme or ends in a colon, a colon in the login, a url that holds a credential) fall from 1.65M to
0.44M (-73%). The rest of the 4.45M is mostly legitimate: Android and app logins that are dates or ids with slashes (`20/01/1990`). What is left of the clearly-junk kinds is a
long tail of small shapes (JSON blobs, `label:|:value`, a bare host as the login of `host:password`).

*Speed:* `parseULPStream` on one 100 MB file, two rounds each, 6.10 / 6.34 s for the committed v6 and 6.17 / 6.49 s for v6.1 (within the noise of a loaded machine, the pipe check
runs before any trim); `parseLine` alone 4.8-5.0 s for both.

*The 3.0M run-4 rows with a `/` in the login* (0.76% of partition 202610) are the reason rule J exists: they were invisible to the driver's junk signature (a colon in the login).

## The T3 keep-list (wealth rule)

`INGEST_FILTER_HARD_DROP_TIERS=T3` stays, with a new policy-level setting **`INGEST_FILTER_HARD_KEEP_COUNTRIES`**, default
`SA,CZ,SI,LT,PL,EE,HR,RO,SK,RU,TR,LV,BG,PA,KZ` (empty = no exception). A line whose T3 signal belongs to a listed country is kept. The country is that
of the **first T3 signal `classifyTier` uses** (e-mail suffix, then e-mail provider, then url TLD); providers map to their country by the headings of
`lib/country-tiers.ts` (`mail.ru`, `yandex.ru` -> RU; `wp.pl`, `o2.pl`, `onet.pl`, `interia.pl` -> PL; the `.cz` portals -> CZ; `abv.bg`... -> BG;
`yahoo.ro`, `mail.ro` -> RO; `mynet.com`, `ttnet.net.tr`, `turk.net` -> TR). The tier arrays and the stored `country_tier` column are **not** changed, so the
UI filters and `scripts/purge-existing-*.sh` (which ask `shouldDropAtIngest`) stay consistent.

| Country | GDP per capita, PPP (World Bank 2024) | T3 lines in the pile |
|---|---|---|
| Saudi Arabia | $71.9k | 6.9M |
| Czechia | $57.6k | 6.1M |
| Slovenia | $57.6k | 0.6M |
| Lithuania | $55.7k | 1.0M |
| Poland | $51.3k | 12.9M |
| Estonia | $50.4k | 0.8M |
| Croatia | $49.6k | 0.7M |
| Romania | $49.1k | 5.3M |
| Slovakia | $47.8k | 1.4M |
| Russia | $47.7k | 28.2M |
| Türkiye | $45.1k | 11.0M |
| Latvia | $43.9k | 0.9M |
| Bulgaria | $42.0k | 2.8M |
| Panama | $41.4k | 0.4M |
| Kazakhstan | $41.0k | 0.1M |
| **Kept** | | **79.2M lines, ~9.6 GiB at ~130 B per row** |

Just below the line (not kept): Malaysia $38.8k, Uruguay $36.6k, Chile $36.1k, Argentina $30.5k. The site-value alternative (T3 lines on government,
finance, crypto, payment and corporate hosts: 105M lines, 80% of them government portals) was offered and not chosen.

## Three speed fixes (output byte-identical)

Measured on one 100 MB file (1.63M lines, 1.22M kept rows) on a busy machine; the importer's single Node thread is the bottleneck (~92% of one core).

| Fix | Today | After | Where |
|---|---|---|---|
| tier check: `classifyTier` does ~400 string comparisons per call; replace the arrays by `Set`s over the dot-suffixes of the e-mail domain and the provider names, and scan the url by index instead of splitting it | 5.0 s of the 10.3 s `parseLine` time per file | ~0.5-1 s | `lib/country-tiers.ts` |
| `batchDedupToken`: 10 `md5.update` calls per row | 1.61 us/row | 0.44 us/row (one update per 2000 rows, identical token) | `lib/upload-dedup.ts` |
| `insertBatch`: one stream chunk per CSV row | 1.57 us/row | 0.57 us/row (2000 rows per chunk, no-quote fast path, identical bytes) | `lib/upload-processor.ts` |

About 7 s of ~17 s measured CPU per file, i.e. up to ~40% of the importer's measured CPU; the true wall-clock gain is checked on the production image
(expected: the redo takes 6-8 h where run 4 takes ~11 h). Each fix has a differential test over millions of real (e-mail, url) pairs and rows that must be
identical, plus the existing suites.

## Verification plan

1. **Unit tests first (TDD)** for every rule, with the shapes above, their guards and the lines that must not change; the existing parser suites updated
   where a policy changed (`login == password`, the mojibake cases that are now valid UTF-8).
2. **Whole-file differential** old parser (624b845) vs v6 with `stream-diff`, on ~30 pile files of different families: every row only the old parser
   produces must be one of the intended changes (UTF-8 value fix, `login == password`, T3 keep); every row only v6 produces must belong to one of the classes A-E,
   UTF-8, `login == password` or T3 keep; **everything else must be 0**.
3. **Speed fixes:** identical `classifyTier` output on all (e-mail, url) pairs of the sample plus a fuzz set; identical token and CSV bytes.
4. **Rehearsals on the production image** (isolated stack): the existing alert, upload-resilience, novelty and disk-gate scripts, plus a `v6` scenario
   with one file per rule.
5. **Live checks after the redo:** the per-file exact recount (`verify-file.mts`) on a spread of files, global checks on the new partition (0 duplicate
   hashes, junk signature, `t.me/` leftovers, double-encoding signature ~0, empty fields), a hash-bucket probe against the old partitions, the search
   dictionary build, the 04:00Z / 05:00Z cron lines, and a UI check by the owner.

## Rollout (the redo)

Preconditions: run 4 complete and its global checks recorded, the build proven, the owner's go. Then, with a warning before the restart:

1. Tag the running image as the rollback **before** building (`ulp-suite-app:rollback-<date>`), build from the merged commit with `git archive` (not from a
   worktree), deploy with `up -d --no-deps app` anchored to the primary checkout's `.env` (`--project-directory`, `--env-file`).
2. Reset: `DROP PARTITION '202610'` (with `max_partition_size_to_drop = 0` if refused), delete the pile's `ulp.sources` rows (the run's rows and the 20 older
   same-name rows), unlink the `inbox/done` hardlink names (inode and link-count guard; this frees no space while the originals exist). The originals are not touched.
3. Feed the whole pile again with the same smallest-first feeder (two files in flight, floor 60 GiB), Monitor armed.
4. Verify (list above), build the search dictionary by hand (`--skip-headroom-check`), check the cron lines.
5. **Side copy:** `scripts/extract-dropped-lines.ts`, a standalone offline tool (8 worker processes, nice 19) that streams every original through the final
   parser and writes every line it does not store (T3 outside the keep-list, rejects) as raw bytes to zstd files, one per original, plus a manifest of
   counts per reason that must equal the importer's counts. Expected ~415M lines, 5-9 GiB, ~40 min. Written outside the repository and the inbox.
6. Only then the owner may delete or move the originals. After the redo is verified: cleanup of the old partitions waits for a backup (below).

**Rollback:** re-tag the rollback image, `up -d --no-deps app`, `DROP PARTITION '202610'`, re-import with the old parser. The older partitions are never touched.

## Disk budget

Run 4 is projected to end near 70 GiB free with partition `202610` near 70 GiB. After `DROP PARTITION` about 140 GiB are free. The redo's partition
should end near 81 GiB (70 GiB + 1.8% more rows + the 9.6 GiB keep-list), i.e. about **59 GiB free**, right at the feeder's 60 GiB floor, before the transient
space of merged-away parts (kept for 8 minutes: 19 GiB at one point of run 4). The feeder and the app's own gate pause by themselves and resume, so a brief
pause near the end is expected, not a fault. What actually frees or saves space, in the order to use it:

1. **Defer the 12 largest files** (45 GiB of input): they are fed last, so stopping before them costs nothing already done. Pre-authorized by the owner.
2. **Remove the 34 stopped Strix sandbox containers** (33.7 GB). The owner said yes in the interview, but they belong to another project, removal is irreversible
   and they may hold output, so it is confirmed with the owner again right before, after looking at what is in them. The session that drives the run declined to act
   on a relayed authorization, which is the right call.
3. **Not a lever:** unlinking the `inbox/done` names frees nothing by itself. Each name is a second hardlink of the original's inode, so the blocks stay allocated until the
   originals go. It only matters after the owner deletes the originals.

The side copy needs 5-9 GiB more and the dictionary 2.2 GiB.

## Related work agreed in the same interview (not part of this change)

- **Backup (rehearsed on 2026-10-12, throwaway MinIO, small synthetic table, no credentials):** the wrapper's `full`, `inc`, `list` and `status`, and
  a partition-limited backup, all work against an S3-compatible target, and a restored copy matched the live table row for row (equal row counts and
  equal sums of the content hash). The restore drill (`verify`) needed two fixes, to be made in the build: `clickhouse.default_replica_path:
  /clickhouse/tables/{shard}/{database}/{table}` in `docker/clickhouse-backup/config.yml` (the tool's default uses a `{cluster}` macro this server does
  not define), and `--tables 'ulp.*'` in the wrapper's `verify` (a comma list together with `--restore-database-mapping` builds a pattern that matches nothing).
  The compose service should also forward `S3_FORCE_PATH_STYLE` and `S3_DISABLE_SSL` (needed for MinIO-like targets). The space guard refuses a real backup while
  free space minus the largest partition is below 140.5 GiB, so the first real backup should be the static partitions only (`--partitions 202607,202608`,
  ~96 GiB), or run with `BACKUP_FORCE=1` knowingly. A real destination is still needed; the old partitions' cleanup waits for it. That cleanup (~20M junk
  or tag rows, ~1.6M garbled-UTF-8 rows, 3.2M "Case D" rows, ~650K mangled-T3 rows) rewrites ~130 GiB.
- **Login-only search scope:** a `login:` prefix and a small "search in" dropdown on the credentials page (a login-column token lookup takes ~0.1 s; the
  all-columns keyword search takes ~16 s; an exact e-mail takes ~1.2 s). Small change after the redo.
- **CSV export:** raise the 10,000-row cap to ~1M and stream the file. Separate project after the redo.
- **GitHub:** the owner makes the repository private in the settings; the Dependabot file stays out.

## Risks

- The v6 rules enlarge what is stored by ~1.8%; the filters (e-mail login for 2-part padded lines, the URL-fragment filter, the common-port list) are the
  guard against junk. The differential proof (step 2) is what shows whether a guard is too loose; the sample's masked failures are listed in the plan.
- Deploying mid-redo is not planned; a deploy always follows the "wait for nothing in `inbox/processing`" rule.
- The redo ends at the disk floor; the pre-authorized levers cover it, and the feeder pauses by itself rather than failing.

## Results (2026-10-12)

Measured on branch `parser-v6` with run 4 still going on the live stack. Numbers only: no file names, search terms or credential values.

**Gate (HEAD 435ec3e):** `tsc --noEmit` clean, `eslint` (app, components, lib) clean, `vitest` **194 test files / 2,873 tests passed** (4 files / 58 tests skipped by
design), `next build` exit 0 (run at 21:30 on the final sources: no file under app, lib or components changed after it, and the last commit only touches e2e scripts).

**Candidate image** `ulp-suite-app:v6-candidate`, id `ea163ada5f10`, built from the tree of 8c79c1c. `:latest` is untouched (`474ff5812e25`, run 4's parser 624b845);
the rollback tag `rollback-20261012-run4` points at it. Rehearsals ran on the isolated stack while run 4 kept running:

| Script | Result |
|---|---|
| `e2e-alert-rehearsal.ts` | 36/36 (and again on HEAD 435ec3e: 36/36) |
| `e2e-upload-resilience.ts` | 33/33 |
| `e2e-novelty-ingest.ts`, every scenario except `gate` | first full run 93/96. The three failures were all in `positional`: its fixture held a one-slash password, which rule C now recovers as a stored row. The fixture became a three-slash password in 435ec3e. Rerun of `tags,positional,v6` on HEAD: **27/27** (v6: one line per rule, all stored or dropped as designed) |
| `e2e-disk-gate.ts`, novelty `gate` | **not run yet**: they write tens of GiB of filler and wait until run 4 has finished |

A real-browser pass on the candidate (11 pages: credentials, batch lookup, saved searches, breaches, domains, upload, inbox, sources, users with its
Add User dialog and the Role select, API keys, the public check page) rendered every page with no console error, and the Role select chose both roles.

**Differential proof** (`scripts/parser-diff.ts`: the baseline parser at main 624b845 against the working tree, 30 pile files of different families, about 120M
lines, sampled per file and extrapolated). Every changed line belongs to a named class, **unexplained 0**:

| Class | Lines (millions) |
|---|---|
| space-padded colons | 0.73 |
| Android app id without its scheme | 1.12 |
| slash in the password | 0.032 |
| numeric login (read as a port before) | 0.013 |
| protocol-relative url | 0.19 |
| UTF-8: rejected before, stored now (the repair alone explains it) | 0.094 |
| UTF-8: stored before as double-encoded text, now as the text | 0.15 |
| UTF-8: stored before, not now (the repair makes the old parser reject it too) | 0.000 (5 sampled lines) |
| `login == password`, login not an e-mail | 0.59 |
| T3 kept by the keep-list | 3.26 |
| unexplained | 0 (0 sampled lines) |

Whole-file multiset diffs of 21 of those files (chosen to hold every class, so not a pile-wide estimate): 10,525,176 rows before, 10,976,990 after (+451,814);
every one of the 17,608 rows only the old parser stores is one of four old defects: double-encoded text 11,846, a mangled Android id 5,461, UTF-8 text 297,
the positional-fallback junk row 4.

**Speed** (one ~100 MB pile file, 1.63M lines, busy machine; outputs byte-identical, the tests keep the old code as the reference): `parseLine` with the T3
predicate 10.3 s -> 6.3 s (5.3 s without the predicate in both runs), so the predicate went from about 5 s to about 1 s per file; `classifyTier` alone 1.72 -> 0.65
us/row; the md5 token 1.61 -> 0.44 us/row and the CSV step 1.57 -> 0.57 us/row per kept row. The wall-clock gain on the production image is measured during the
redo (expected 6-8 h for the pile against run 4's ~11 h).

**Dependency refresh** (in range, `package.json` unchanged): `next` 15.5.27 (already the newest in range), `react` and `react-dom` 19.2.6 -> 19.3.0,
`better-sqlite3` 12.10.0 -> 12.11.1, `@clickhouse/client` 1.23.1 -> 1.24.1, `@radix-ui/react-select` 2.2.6 -> 2.4.0; 178 packages changed, 32 added, 31 removed in
the lock file (60 of the changed ones are production dependencies). The one code change it needed is `asRole` in `app/users/page.tsx`: the new select passes a plain string.

**Not done in this change:** the two disk-filling rehearsals (above); the deploy and the redo itself, which follow `docs/pile-import-runbook.md` once run 4 is
complete and the owner says go; the follow-up projects listed above (login-only search scope, CSV export, a real backup destination).
