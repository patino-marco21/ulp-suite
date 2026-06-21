# Task 1 Report — Shared 200-row Domain A→Z Defaults

Implemented Task 1 on branch `fix/pagination-import-resilience`.

## What changed

Added shared credential browse defaults and wired them into the credentials UI and API:

- `DEFAULT_CREDENTIAL_LIMIT = 200`
- `MAX_CREDENTIAL_LIMIT = 200`
- `DEFAULT_CREDENTIAL_SORT = 'domain_asc'`

The shared constants now drive:

- the credentials page initial sort and page size
- the Clear All reset fetch
- the sort-cycle reset branch
- the credentials API default limit and sort parsing

Cursor pagination behavior in `lib/cursor-pagination.ts` was left unchanged.

## Files changed

- Created `lib/credential-browse-defaults.ts`
- Created `__tests__/credential-browse-defaults.test.ts`
- Modified `app/credentials/page.tsx`
- Modified `app/api/credentials/route.ts`

## TDD evidence

### RED

Command:

```bash
npm test -- __tests__/credential-browse-defaults.test.ts
```

Result:

```text
FAIL  __tests__/credential-browse-defaults.test.ts
Error: Cannot find package '@/lib/credential-browse-defaults' imported from
C:/Users/coler/Desktop/vault-refactor/bron-vault-pagination-import/__tests__/credential-browse-defaults.test.ts
```

This was the expected failure because the shared defaults module did not exist yet.

### GREEN

Command:

```bash
npm test -- __tests__/credential-browse-defaults.test.ts
```

Result:

```text
✓ __tests__/credential-browse-defaults.test.ts > credential browse defaults > defaults to 200 rows ordered globally by domain A to Z
✓ __tests__/credential-browse-defaults.test.ts > credential browse defaults > the UI and API consume the shared defaults
```

### Focused verification

Command:

```bash
npm test -- __tests__/credential-browse-defaults.test.ts __tests__/cursor-pagination.test.ts
```

Result:

```text
2 test files passed
20 tests passed
```

### Full verification

Command:

```bash
npm test
```

Result:

```text
25 test files passed
620 tests passed
```

## Self-review

Checks completed:

- Shared defaults are centralized in a new library module.
- UI and API both consume the shared constants.
- Clear All still preserves `exclude_noise=1&dedupe=1`.
- Reset sort now returns to the shared default sort.
- Cursor pagination logic and tests still pass unchanged.

No unrelated files were modified.

## Concerns

- The credentials route now defaults to `domain_asc` and `200` for first-page browse requests. That matches the brief, but any client that relied on the old implicit defaults will see the new behavior unless it sends explicit query parameters.
