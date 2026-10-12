# Parser v6, three speed fixes and a T3 keep-list: design and the redo of the pile import (2026-10-12)

Status: **design for the owner's review, nothing implemented yet.** Written after a review of what the parser still gets wrong, requested by the owner
before the 140 GiB of original files are touched. Every number below comes from a read-only survey of the pile (a sample of 4.5 GiB, 76.7M lines, taken
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
   same-name rows), unlink the `inbox/done` hardlink names (inode and link-count guard). The originals are not touched.
3. Feed the whole pile again with the same smallest-first feeder (two files in flight, floor 60 GiB), Monitor armed.
4. Verify (list above), build the search dictionary by hand (`--skip-headroom-check`), check the cron lines.
5. **Side copy:** `scripts/extract-dropped-lines.ts`, a standalone offline tool (8 worker processes, nice 19) that streams every original through the final
   parser and writes every line it does not store (T3 outside the keep-list, rejects) as raw bytes to zstd files, one per original, plus a manifest of
   counts per reason that must equal the importer's counts. Expected ~415M lines, 5-9 GiB, ~40 min. Written outside the repository and the inbox.
6. Only then the owner may delete or move the originals. After the redo is verified: cleanup of the old partitions waits for a backup (below).

**Rollback:** re-tag the rollback image, `up -d --no-deps app`, `DROP PARTITION '202610'`, re-import with the old parser. The older partitions are never touched.

## Disk budget

Run 4 is projected to end near 70 GiB free with partition `202610` near 70 GiB. After `DROP PARTITION` about 140 GiB are free. The redo's partition
should end near 81 GiB (70 GiB + 1.8% more rows + the 9.6 GiB keep-list), i.e. about **59 GiB free**, right at the feeder's 60 GiB floor. The owner has
pre-authorized the levers for that case: remove the 34 stopped Strix sandbox containers (33.7 GB), unlink the `inbox/done` names of finished files, and defer
the 12 largest files. The side copy needs 5-9 GiB more and the dictionary 2.2 GiB.

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
