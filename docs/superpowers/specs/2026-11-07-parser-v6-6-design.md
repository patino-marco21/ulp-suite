# Parser v6.6: an app id behind a web scheme, a host with a trailing dot, an underscore in a host; a zip with nothing to read — design and results (2026-11-07)

Date: 2026-11-07
Status: **Deployed on 2026-11-07 (image `30447d3b320d`, rollback tag `rollback-20261107-2305z`); see "Results". The re-read of the archive is in progress or done as "Results" says.**
Related: `2026-11-06-site-annotation-design.md` (the parser v6.5 this follows), `2026-11-07-file-ledger-design.md` (the re-feed this ends with).
File names, channel names, search terms and credential values are deliberately absent (the repository is public); every fixture is invented.

## Why

After the re-feed of the older files (same day) the question was whether the parser still misses a layout. A read-only survey ran the production per-line path over four 2 MiB slices of every
archived file (745 files, 437 GiB, about 8.4 billion lines; counts weighted by file size, so a ranking, not an exact figure). What it found:

- Of the lines that are neither empty nor dropped by the T3 policy, 95.9% are stored. The rejects are mostly policy: a placeholder login, a "not saved" password, a login with white space, a password under three
  characters, an e-mail equal to its password. Of the lines no field split could read, only 0.25% of all lines could hold a credential, and no shape is above 0.02%: the earlier finding (no more rules from the
  top reject families) holds.
- 0.29% of all lines (24 million) are rejected because the **host of an http(s) url is not a valid host**. Taken apart:

  | Host form | Lines | Verdict |
  |---|---|---|
  | no dot (one label) | 7.8 M | not built: two thirds of a sample of the rows it would add have the host `localhost`, most of the rest are url fragments (`html`, `login`, `cgi-bin`, a scheme with a digit in it) or router names |
  | a second scheme inside the url | 6.9 M | 5.9 M of them are an **Android app id behind a stray `https://`** (rule O) |
  | other punctuation, a dot or hyphen at a label edge, an empty host, white space | 8.0 M | junk, stays rejected |
  | an underscore in a label | 1.1 M | **part of it is a host** (rule R); the rest are Android package names and file names |
  | a trailing dot (a fully qualified name) | 0.4 M | **a host** (rule Q) |

- 12.6 M lines in the archive start `https://android://`. 5.9 M are rejected (a username login); 5.6 M have an e-mail login and were stored **without their site**, because the salvage rule for a bad host keeps an e-mail
  credential and drops the url.
- Not built, the owner's decisions: a login that holds a space (21 M lines read as stored rows if allowed; 99% have a url, three quarters are shaped like a person's name; the rule says no real address has a space, but
  a login that is not an address may), a password that is an e-mail address (0.25–0.37% of the stored lines, most with a login that is not an address), a password that is a hash (about 0.1%), and the `%XX` decoding of
  every password (about 0.05% of the stored lines are changed by it).
- Intake: a `.zip` whose entries are not named `.txt` or `.csv` finished as "done" with 0 rows and no word in the log (the other half of the same survey).

## The rules

**O: a web scheme in front of an app id** (`stripWebSchemeBeforeAndroid` in `lib/ulp-recover.ts`, applied in `parseInlineLine`). A line that starts `http://android://` or `https://android://` is read without the web scheme, as the app-id line it is,
and marked `androidRecovered`, so the stream parser keeps one row per login and password per file (the same rule as for app ids that lost their `android://`). A web url is never `https://android://`: its first host would be `android:`.

**Q: a trailing dot** (`extractDomain`). `portal.example.org.` is the host `portal.example.org`. The url is stored as it was written; the `domain` column has no dot.

**R: an underscore in a label** (`isValidHost`). Accepted when the host has an underscore in a label in front of the last, the last label is two to 24 letters, and the last label is not the name of a file type (`asp`, `html`, `php`, ...).
An Android package name (`com.bank.app_name`) and a file name (`main_login.asp`) behind a web scheme stay rejected. A host longer than 253 characters is rejected before any pattern runs.

**Zip entries.** An entry whose name is not `.txt` or `.csv` is still skipped, but counted: the log says how many and of which types, and a zip with no `.txt` or `.csv` entry at all fails with that reason instead of finishing with nothing.
An empty zip, or one with only folders, ends as before.

## Decisions

- Rule O applies to every line with the prefix, the e-mail logins included. They used to be stored without a url; now they carry the app id, like every other app-id line. The url-less rows already stored stay (no repair).
- Hosts without a dot are not read. The measured sample says the rule would mostly add `localhost` rows and url fragments; `localhost` alone would be a one-line change if the owner wants it.
- Nothing else of the survey changed: the rules for white space in a login, an e-mail or a hash as a password, and the decoding of `%XX` are the owner's.

## Tests

`__tests__/ulp-parser-v6-6.test.ts` (rule O in the line and the stream path, Q, R with the shapes that must stay rejected, a linear-time check on hostile hosts, the differential classes), three zip cases in `__tests__/upload-processor.test.ts`,
`scripts/e2e-novelty-ingest.ts` scenario `v66` on a real ClickHouse. `scripts/parser-diff.ts` knows the classes `android-web-prefix`, `host-trailing-dot` and `host-underscore`, and in stream mode the old-only class `site-added`.
`PARSER_REVISION` is 66: every file read by an older parser is eligible for a re-feed again.

## Results

**Proof.**
- Full suite 5,263 passed, typecheck and lint clean.
- Rehearsal on the candidate image against a real ClickHouse: `basic`, `v6`, `v65`, `v66` 44 of 44 checks (the alert rehearsal that brings the stack up 51 of 51).
- Differential against the committed v6.5 over 251 archived files (about 2.5 billion lines, sampled): android-web-prefix 3.44 M lines, host-trailing-dot 0.07 M, host-underscore 0.10 M, **unexplained 0**.
- The first run of it found a regression of mine: a 253-character cap on every host also rejected a very long token-shaped host the old check accepted (4 sampled lines). The cap now belongs to the underscore branch alone; the first pattern is unchanged. A look at the examples of the underscore family then showed labels that start or end with an underscore, which are junk: underscores are allowed only inside a label.

**Exact count over the whole archive** (745 files, 437 GiB, every line that holds one of the three layouts read by the v6.5 parser and by v6.6): 9,461,547 lines change. Android app ids behind a web scheme: 3,515,435 distinct accounts (login and password, per file) that were rejected, and 3,167,816 that were stored without their site. Trailing dot 257,203 lines, underscore 361,659. No other line changes (0).

**What the table gains.** The earlier sample said about 22% of the rejected app-id accounts are new to the table (the same account is often in the table under the same app id from another file), 46% of the host rows. Expected: about 0.8 M new credentials from the app ids, about 0.4 M from the hosts, and up to 3.2 M rows that carry a site for a login and password the table already held without one. The files are not spread evenly: 98 files (160 GiB) hold 90% of the changed accounts and rows, 137 files (210 GiB) hold 95%.
