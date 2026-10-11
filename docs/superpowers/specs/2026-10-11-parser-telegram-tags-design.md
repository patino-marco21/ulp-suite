# Parser: Telegram channel tags on credential lines — design (2026-10-11)

Status: **implemented on 2026-10-11** (branch `parser-telegram-tags`; code `lib/ulp-telegram-tag.ts` and three small edits in `lib/ulp-parser.ts`, tests
`__tests__/ulp-parser-telegram-tags.test.ts`, rehearsal scenario `tags` in `scripts/e2e-novelty-ingest.ts`). Found while verifying the first
import of a 130 GiB pile of Telegram-sourced files: the accounting was exact, but the parser silently lost or corrupted credential lines
that carry a channel tag. No source file names appear here on purpose: the repository is public.

## What was wrong

Channels that repost combo lists append their own link, and sometimes an advert, to the lines:

```
shop.example.test/:alice:Secret1 https://t.me/SomeChannel
https://shop.example.test/login:alice@mail.test:Secret1t.me/SomeChannel  You can buy dm @SomeChannel
shop.example.test/login:alice@mail.test:Secret1          @best_ulp - daily | https://t.me/+AbC123
```

Measured on the 503 text files of the pile (grep and the app's own parser, 2026-10-11):

| Finding | Number |
|---|---|
| credential lines that end in a tag or an advert tail | 5.0M, in 177 files |
| of them in the two files that are entirely tagged with ` https://t.me/Channel` | 2.69M (the parser rejected 99.8% of those lines as `no_fields`) |
| one more file where the tag is glued to the password with a long advert tail | 1.12M lines, 97% rejected, the rest stored with the tag inside the password |
| rows already stored by this run with a Telegram link in the password / in the email | 288k / 64k (of 81.8M) |
| the same shapes in the 1.39B rows imported before | 1.79M with a link in the password, 290k in the email, 260k with a padded advert in the password |

Three mechanisms produced them. (1) The extra `:` and `/` of the tag break the field split, so the whole line was rejected. (2) A tag glued
onto the password, or an advert after padding, was accepted and stored inside the password (the existing pipe rule removed the link but left
the advert). (3) A banner or watermark line (`🔥 DAILY PREMIUM https://t.me/+x 🔥`, an invite link on its own) was either taken for the
login or password of a neighbouring line, or, when it started with `http`, switched the stream parser into its positional mode, which
swallowed the next two real lines as a login and a password and stored junk.

## Rules

1. **Cut a trailing tag** (`stripTelegramTag`, applied by `parseLine` right after the blank-line rule, so every parser path gets it).
   It acts only when (a) the text after the first `t.me/` has no further `:` (the link is the end of the line; a credential whose url is a
   t.me link is untouched), (b) a non-scheme `:` stands in front of it (a bare invite line is untouched), and (c) for a link glued onto a
   letter or digit, that letter is not the end of a host name (`user:pass@payment.me/x`). It removes the scheme remnants in front of the
   link (`https://`, `https : //`, `://`, a doubled scheme, `www.`), then an advert that is separated from the password by padding
   (3 or more white-space characters after the last `:`), then separators left behind.
2. **A Telegram link left in a login or password is junk** (`hasJunkMarker`, the gate every emission path already shares: line, block and
   positional). After rule 1 such a link is a watermark that a field split took for a field. A host name such as `mypost.me/` does not count
   (the link needs a non-alphanumeric character in front of `t.me/`).
3. **A banner line never starts positional mode** (both stream-parser entry points): a bare `http...` line that holds a Telegram link is not a URL.

## Verification (on the real pile, before anything was deployed)

- 37 new unit tests (synthetic fixtures); the full suite, 2,608 tests, is green.
- **Differential run, old parser (`main`) against the new one, per line:** 6.3M real lines from 21 random pile files. **0 changes on any line
  without `t.me/`**; 4.74M lines accepted identically, 1.24M rejected identically; the only differences are on tagged lines: 294k rejected lines
  recovered, 19k stripped of their tag, 138 junk rows removed, 5k rejections that now fail for the real reason (no password).
- **Whole files through `parseULPStream`** (positional logic included): untagged files identical (0 only-in-old, 0 only-in-new); a tagged file
  replaces 41,000 passwords with an advert tail by the clean ones; another recovers the lines the positional trap swallowed and drops the junk
  rows built from banner lines.
- The `tags` scenario of `scripts/e2e-novelty-ingest.ts` runs the same cases through a real upload on the production image: 8 real credentials stored
  with clean passwords, the banner and the watermark skipped, nothing after the banner lost.

## Rollout and clean-up

1. Deploy the image (local, rollback tag first, never while an import runs).
2. Rows this run already stored for files that contain a Telegram link (260 files, 16 GiB) carry the old, wrong parse. They are re-imported:
   delete those files' rows from the current month's partition and their rows in `ulp.sources`, then feed them again; the novelty check makes
   the re-import exact, and `verify-file` style recounts confirm every file (parse, split, completeness, attribution) afterwards.
3. The 2.1M affected rows of the older partitions are NOT touched: rewriting them needs a backup and about 130 GiB of headroom (the owner's
   decision, see the 2026-10-01 notes).

## Not done

- Rejecting passwords with a run of 3 or more spaces and no link (136k rows of this run, junk text rows): a separate rule that needs its own
  measurement against the older data.
- Tags in the block-labelled (`URL:` / `USER:` / `PASS:`) format: none were found in the sampled files.
- A watermark embedded in a host name (`android://x==@net.🔥 DAILY https://t.me/+x 🔥.example/`) is rejected, not repaired.
