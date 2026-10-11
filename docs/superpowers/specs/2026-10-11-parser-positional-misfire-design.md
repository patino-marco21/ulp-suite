# Parser: the positional fallback swallowed real lines, and `https://e-mail:password` was dropped — design (2026-10-11)

Status: **implemented on 2026-10-11** (`lib/ulp-parser.ts`: `canBeLoginLine`, two small edits in the line loops of `parseULPContent` and
`parseULPStream`, and one branch in `colonSplit`; tests `__tests__/ulp-parser-positional-guard.test.ts` and
`__tests__/ulp-parser-scheme-email-pair.test.ts`; rehearsal scenario `positional` in `scripts/e2e-novelty-ingest.ts`). Found while
chasing seven stored rows that an offline re-parse of one pile file did not reproduce. No source file names appear here on purpose: the
repository is public.

## What was wrong

**1. The positional "3-line fallback" took the next two lines for a login and a password.** A line that starts with `http` and that
`parseLine` rejects as `no_fields` was treated as the first line of a label-free stealer-log record (URL, login, password lines). The next
two lines were consumed as its login and password, whatever they were. In a colon-separated combo list the rejected line is not the start of
a record; it is a credential line the field split could not take (a `/` in the password, a login that is an e-mail address with no url), and the two
lines after it are well-formed credentials of their own:

```
https://shop.example.test:alice:Pass/word1        <- rejected (no_fields)
https://one.example.test:carol:Secret1            <- taken for the login
https://two.example.test:dave:Secret2             <- taken for the password  => ONE junk row, two real lines lost
```

The stored junk row has a whole line in each of its three fields. It is the same mechanism as the 2026-06-28 incident (a port regex made a
line `no_fields`; that cause was fixed, the mechanism was not).

**2. `https://alice@mail.test:Secret1` was rejected.** A stray scheme in front of an e-mail address, no url (the url field was empty when the
list was made). The field split found two fields after the scheme where it needs three, so the line was `no_fields`, which also opened the
positional trap above. The parser already salvages an e-mail:password pair elsewhere (a junk host with a real e-mail login drops the url).

Measured with `://` in both the stored url and the stored login (the junk row's signature) and with the app's own parser:

| Finding | Number |
|---|---|
| stored rows with that signature, before this run | 13.30M (July) + 6.00M (August) |
| stored rows with that signature, from the first 352 pile files | 1.86M of 134.5M (1.38%), in 207 files = 72% of their bytes |
| a heavy file: junk rows among its stored rows | 29% (108,602 of 372,600) |
| the same file, lines rejected as `no_fields` | 256,085 of 3.26M, of which **216k are `https://e-mail:password`** |
| real lines lost per junk row | 2 |

So an import with this parser lost about two real credential lines and stored one junk row per swallowing, and rejected every
`https://e-mail:password` line; in the heaviest families that was 13% of the credential lines.

## Rules

1. **A positional record continues only while the line after the URL line can be a login** (`canBeLoginLine`): it must not contain `://`
   (another URL, an `android://hash@com.app` id) and `parseLine` must reject it as `no_fields` (a line that is itself a credential,
   `alice:Secret1`, `alice|Secret1`, `https://site.com:alice:Secret1`, is not a login). Otherwise the pending URL line is counted as rejected
   (`no_fields`) and the line is read on its own. A genuine record (bare URL, a lone login such as `alice@mail.test` or `john`, a password) is
   untouched: the section G tests of `ulp-parser-block.test.ts` pass unchanged. Applied in both entry points (`parseULPContent`, `parseULPStream`).
2. **A stray `http(s)://` in front of an e-mail address and a password is an e-mail:password pair with no url** (`colonSplit`, the branch for a
   scheme with no path). Only when the text after the scheme is a strict e-mail address (`name@host.tld`, no `/`, `:` or white space), the
   rest is not a port number (`https://user@host:8080`), and the scheme is http or https (`android://hash@com.app:x` is not a pair). Nothing
   that parsed before changes: this branch used to return "no fields".

## Verification (before anything was deployed)

- 36 new unit tests (synthetic fixtures); the 7 parser test files (512 tests) and the full suite (2,646 tests) are green. Against the parser
  without these two changes 19 of the 36 fail (red), then all pass; the 17 that pass either way guard what must not change.
- **Whole files through `parseULPStream`, the deployed parser against this one** (multiset of credentials, repeats kept):

  | file (size) | old accepted / rejected | new accepted / rejected | only the old parser | only the new parser |
  |---|---|---|---|---|
  | combo list A (100 MB) | 1,188,569 / 54,602 | 1,553,962 / 78,411 | 168,062: 168,058 junk rows, 4 of the same family | 533,455: 319k swallowed lines, 214k `https://e-mail:password` pairs |
  | combo list B (336 MB) | 5,348,261 / 221,534 | 5,363,683 / 242,148 | 15,368: 15,354 junk rows, 14 same family | 30,790 |
  | combo list C (≈9.4M rows) | 9,146,415 / 304,801 | 9,231,670 / 475,918 | 59,070: 59,020 junk rows | 144,325 |
  | combo list D (331 MB) | 5,120,465 / 233,232 | 5,179,211 / 282,866 | 44,941: 44,793 junk rows, 139 glued Telegram tags, 9 same family | 103,687 |
  | a list with few failures (32 MB) | 263,778 / 208,233 | 264,607 / 209,392 | 0 | 829 |
  | e-mail lists, 3 files (2.1M, 1.7M, 0.4M rows) | identical | identical | 298 / 267 / 4 rows with a glued Telegram tag | the same lines, cut clean |

  "Junk rows" are rows with a whole line, or a credential line, in the login field. Nothing the old parser produced from a well-formed line was
  lost except through the shifted alignment described below. Files past 16.7M credentials do not fit the comparison's Map; those were not compared.
- **What is still rejected** on a heavy file after both changes: 1.3% of its lines (was 7.8%), of which 0.5% have a `/` in the password behind a
  host and a login, most of them truncated hosts (`https://g:com:...`) that are not credentials; the rest have no login at all.
- The `positional` scenario of `scripts/e2e-novelty-ingest.ts` runs the same cases through a real upload on the production image
  (rehearsal 2026-10-11: alert 36/36, novelty `basic,tags,positional` 32/32).

A residual that is left on purpose: a rejected `http` line, then a rejected line that is not a URL and has no credential shape (for example
`any.do/x::y`), then a credential line. The second line still counts as a lone login and the third as the password, so one junk row is built and
one real line is lost. It is about 2 lines per million in the files above; closing it needs a check on the password step too, which would
reject a genuine record whose password contains a colon.

## Rollout

The rows this parser produced before are wrong in a way that touches almost every imported file (98% of the pile's imported bytes in the new
month's partition), so the new month's partition (the pile import, 134M rows, nothing else in it) is dropped and the pile is imported again
with this parser; the files are untouched on disk. The older partitions keep their 19.3M junk rows: removing them needs the owner's decision
(a lightweight delete is cheap, but the real lines they swallowed cannot be recovered without the original files).

## Not done

- A password with a `/` in it behind a host and a login (`https://host:alice:pa/ss`): the field split takes the first `/` for the start of a
  path and rejects the line (0.5% of the lines of a heavy file). Not fixed: a heuristic for "the `/` belongs to the password" needs its own
  measurement.
- Lines with a url and a single value (`https://host/path:value`, no login) are not credentials and stay rejected.
