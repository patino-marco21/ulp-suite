# NORM_EXPR Sweep Part 2 — domain-monitor + export route

## Goal

Fix two remaining raw `domain =` WHERE comparisons that silently miss Cases A–D corrupted
rows. Closes every known NORM_EXPR gap across all query paths.

---

## Background

Cases A–D corrupted rows have wrong values in the raw `domain` column until ALTER TABLE UPDATE
mutations are issued. `NORM_DOMAIN_EXPR` corrects them at query time. The previous cycle fixed
four v1 API endpoints. Two query paths were missed.

---

## Files Changed

### `lib/domain-monitor.ts`

`NORM_DOMAIN_EXPR` is already imported. Fix the live-upload monitor check query (line ~395):

```ts
// before
AND (domain = {domain:String} OR endsWith(lower(email), {emailSuffix:String}))

// after
AND ((${NORM_DOMAIN_EXPR}) = {domain:String} OR endsWith(lower(${NORM_DOMAIN_EXPR}), {emailSuffix:String}))
```

---

### `app/api/export/route.ts`

`NORM_DOMAIN_EXPR` is already imported. Fix the domain filter in the POST handler (line ~88):

```ts
// before
extras.push(' AND domain = {exportDomain:String}')

// after
extras.push(` AND (${NORM_DOMAIN_EXPR}) = {exportDomain:String}`)
```

---

## File Map

| File | Change |
|---|---|
| `lib/domain-monitor.ts` | NORM_DOMAIN_EXPR in live-upload monitor WHERE |
| `app/api/export/route.ts` | NORM_DOMAIN_EXPR in domain export filter WHERE |

No schema changes. No new files. No migration required.

---

## Testing

- All 373 existing tests must continue to pass
- `tsc --noEmit` must pass
- New unit tests in `__tests__/norm-expr-sweep-part2.test.ts` verifying that the two
  code paths interpolate NORM_DOMAIN_EXPR (same approach as `ulp-normalize-where.test.ts`:
  import the expression, assert it is a non-empty string containing `if(`)
