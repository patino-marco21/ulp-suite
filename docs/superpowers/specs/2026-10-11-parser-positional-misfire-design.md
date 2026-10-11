# Parser: the positional fallback swallowed real lines, and three line layouts were dropped — design (2026-10-11)

Status: **implemented on 2026-10-11** (`lib/ulp-parser.ts`: `canBeLoginLine`, two small edits in the line loops of `parseULPContent` and
`parseULPStream`, one branch and one helper (`splitLoginPasswordUrl`) in `colonSplit`; `lib/ulp-telegram-tag.ts`: one condition; tests
`__tests__/ulp-parser-positional-guard.test.ts`, `__tests__/ulp-parser-scheme-email-pair.test.ts`, `__tests__/ulp-parser-login-password-url.test.ts` and
two cases in `__tests__/ulp-parser-telegram-tags.test.ts`; rehearsal scenario `positional` and two cases of `tags` in
`scripts/e2e-novelty-ingest.ts`). Found while chasing seven stored rows that an offline re-parse of one pile file did not reproduce, and then by a
survey of what the parser still rejects (45 random pile files, 21M lines). No source file names appear here on purpose: the repository is public.

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

**3. `alice:Secret1:https://shop.example.test/login` was rejected.** The layout login:password:url (the url last). Any line that holds `://` was
read as url-first, so the field split found the wrong fields and returned "no fields". A survey of the pile counted 2.98M such lines in 170
files; in one 5M-line file 438k of them (and 42% of the lines of its first 600k) were rejected.

**4. A Telegram tag with a second link was not cut.** `...:Secret1://t.me/Channel|NAME;@NAME|https://t.me/+AbC123`: the tag stripper
left the line alone because the text after the first link holds a `:` (the one of the advert's own `https://`), so the line was rejected.

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
3. **`login:password:http(s)://url` is read in that order** (`splitLoginPasswordUrl`, tried first when the line holds `://`). Only http(s); the
   fields must stand in front of the scheme; the url may hold no colon but an optional port (so a line that parses as url:login:password is
   never read this way); the login holds no white space and no `/`; both login and password are non-empty. A Telegram tag after the pair is cut
   first, so `alice:Secret1:https://t.me/Channel` is a pair with no url. The rare line `host:alice:https://other/` (a password that is a url)
   is now read as login `host`, password `alice`, url `https://other/` where it used to be rejected.
4. **The colon of a `scheme://` in the advert after the link no longer counts as a field separator** (`stripTelegramTag`). A real credential
   whose url is a t.me link (`https://t.me/Channel:alice:Secret1`, or a password that is a url) is still left alone.

## Verification (before anything was deployed)

- 36 new unit tests for rules 1 and 2 and 24 + 3 for rules 3 and 4 (synthetic fixtures); the full suite (2,673 tests) is green. Against the parser
  without rules 1 and 2, 19 of the 36 fail (red), then all pass; the others guard what must not change.
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
- **Rules 3 and 4, the version deployed on 2026-10-11 against this one:** a 5M-line file in the login:password:url layout 4,450,653 accepted /
  553,570 rejected -> 4,888,386 / 115,837, **0 rows only the old parser produced**, 437,733 only the new one; the heavy file of the table above and a
  32 MB file: identical; an e-mail list: 197 more rows (the tag tail).
- **What is still rejected** across the 45-file survey after all four rules: 0.56% of the lines (1.87% before rules 3 and 4). More than half of a
  random sample of the remaining rejected lines are banner, watermark or invite lines (correctly rejected); by shape, 0.12% of all lines are bare
  urls, 0.07% have a `/` in the password, 0.01% are `url login:password` with a space, and the rest are oddities.
- The `positional` and `tags` scenarios of `scripts/e2e-novelty-ingest.ts` run the same cases through a real upload on the production image.

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
  path and rejects the line (0.07% of the survey, 0.5% of one heavy file, most of the samples are truncated hosts that are not credentials). Not
  fixed: a heuristic for "the `/` belongs to the password" needs its own measurement.
- `url login:password` with a single space between the url and the pair (0.01% of the survey, 1.7% of one file): not recognised.
- `email:password | Label: value`: the pipe rule takes the pipe for the field separator and stores `email:password` as the login (171 lines in the small
  pile files; 1.65M stored rows of the older partitions have a colon in the login without a scheme).
- Lines with a url and a single value (`https://host/path:value`, no login) are not credentials and stay rejected.
- Policy, not parsing: a login equal to the password is rejected (about 1% of the lines of one heavy file), a login with a space (phone numbers) is garbage.
