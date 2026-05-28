# Next.js 15 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade from Next.js 14.2.35 to Next.js 15.2.4 (+ React 19) to patch May 2026 CVEs, fixing 5 files before bumping dependencies.

**Architecture:** Code-first migration — all source changes are made while still on Next.js 14 (backward-compatible with `await` on non-Promise values), then a single dependency bump commits the switch. This keeps every commit individually green and isolates any build-time surprise to the dep bump step.

**Tech Stack:** Next.js 15.2.4, React 19, TypeScript, Vitest, npm

---

## File Map

| File | Change |
|---|---|
| `next.config.mjs` | Remove `instrumentationHook`, promote `serverComponentsExternalPackages` → top-level `serverExternalPackages`, remove `swcMinify` |
| `app/layout.tsx` | `function` → `async function`, `cookies()` → `await cookies()` |
| `app/api/breaches/[name]/route.ts` | 3 handlers: `params: { name: string }` → `params: Promise<{ name: string }>` + `await params` |
| `app/api/breaches/[name]/retag/route.ts` | 1 handler: same pattern |
| `package.json` + `package-lock.json` | Bump next, react, react-dom, eslint-config-next, @types/react, @types/react-dom |

---

### Task 1: Fix next.config.mjs

**Files:**
- Modify: `next.config.mjs`

Context: Three options are deprecated/removed in Next.js 15. Making these changes now (while still on 14) removes noise from the dep-bump diff and avoids runtime warnings.

- [ ] **Step 1: Remove `instrumentationHook: true` from experimental**

Open `next.config.mjs`. Find the `experimental` block:

```js
  experimental: {
    instrumentationHook: true,
    // Tell Next.js not to bundle better-sqlite3 (native addon — must be required at runtime)
    serverComponentsExternalPackages: ['better-sqlite3'],
```

Change to (remove `instrumentationHook` line entirely):

```js
  experimental: {
    // Tell Next.js not to bundle better-sqlite3 (native addon — must be required at runtime)
    serverComponentsExternalPackages: ['better-sqlite3'],
```

- [ ] **Step 2: Promote serverComponentsExternalPackages to top-level**

Remove `serverComponentsExternalPackages: ['better-sqlite3'],` from inside `experimental`.

Add it as a **top-level** key in the `nextConfig` object (outside `experimental`), renamed to `serverExternalPackages`:

```js
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  experimental: {
    // webpackBuildWorker and outputFileTracingExcludes remain here
```

- [ ] **Step 3: Remove `swcMinify: true`**

Find and delete the line:
```js
  swcMinify: true,
```

- [ ] **Step 4: TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: 396 tests pass.

- [ ] **Step 6: Commit**

```bash
git add next.config.mjs
git commit -m "chore(config): clean up deprecated Next.js 15 config options"
```

---

### Task 2: Fix app/layout.tsx — async cookies()

**Files:**
- Modify: `app/layout.tsx`

Context: Next.js 15 makes `cookies()` return a Promise. `await cookies()` works correctly on Next.js 14 too — `await` on a non-Promise value is a no-op that returns the value unchanged — so this change is backward-compatible.

- [ ] **Step 1: Make RootLayout async and await cookies()**

Find these lines (around lines 41–48):

```ts
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read user_role cookie on the server so the sidebar SSR HTML
  // already contains the correct menu items (no 2-step flash).
  const cookieStore = cookies()
```

Replace with:

```ts
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read user_role cookie on the server so the sidebar SSR HTML
  // already contains the correct menu items (no 2-step flash).
  const cookieStore = await cookies()
```

(Two changes: `function` → `async function`, `cookies()` → `await cookies()`.)

- [ ] **Step 2: TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 396 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx
git commit -m "fix(layout): await cookies() for Next.js 15 async request API"
```

---

### Task 3: Fix app/api/breaches/[name]/route.ts — async params

**Files:**
- Modify: `app/api/breaches/[name]/route.ts`

Context: Next.js 15 passes `params` as a Promise. Three handlers in this file still type it as a plain object. Typing as `Promise<{name}>` and `await params` works on Next.js 14 too — `await` on a plain object returns the object unchanged.

- [ ] **Step 1: Fix the GET handler signature and params access**

Find (lines 11–18):

```ts
export async function GET(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const breachName = decodeURIComponent(params.name)
```

Replace with:

```ts
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  if (!user) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

  const { name } = await params
  const breachName = decodeURIComponent(name)
```

- [ ] **Step 2: Fix the PATCH handler signature and params access**

Find (lines 57–65):

```ts
export async function PATCH(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const breachName = decodeURIComponent(params.name)
```

Replace with:

```ts
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { name } = await params
  const breachName = decodeURIComponent(name)
```

- [ ] **Step 3: Fix the DELETE handler signature and params access**

Find (lines 109–117):

```ts
export async function DELETE(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const breachName = decodeURIComponent(params.name)
```

Replace with:

```ts
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { name } = await params
  const breachName = decodeURIComponent(name)
```

- [ ] **Step 4: TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: 396 tests pass.

- [ ] **Step 6: Commit**

```bash
git add "app/api/breaches/[name]/route.ts"
git commit -m "fix(breaches): async params for Next.js 15 compatibility"
```

---

### Task 4: Fix app/api/breaches/[name]/retag/route.ts — async params

**Files:**
- Modify: `app/api/breaches/[name]/retag/route.ts`

- [ ] **Step 1: Fix the POST handler signature and params access**

Find (lines 18–26):

```ts
export async function POST(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const breachName = decodeURIComponent(params.name)
```

Replace with:

```ts
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const user = await validateRequest(request)
  const adminError = requireAdminRole(user)
  if (adminError) return adminError

  const { name } = await params
  const breachName = decodeURIComponent(name)
```

- [ ] **Step 2: TypeScript check**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: 396 tests pass.

- [ ] **Step 4: Commit**

```bash
git add "app/api/breaches/[name]/retag/route.ts"
git commit -m "fix(breaches/retag): async params for Next.js 15 compatibility"
```

---

### Task 5: Bump dependencies to Next.js 15 + React 19

**Files:**
- Modify: `package.json`, `package-lock.json`

Context: All source changes are now in place. This single commit upgrades the framework. If anything breaks after this step, it is isolated to the dependency bump — the 4 prior commits are clean.

- [ ] **Step 1: Install updated dependencies**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault
npm install next@^15.2.4 react@^19 react-dom@^19 eslint-config-next@^15.2.4
npm install --save-dev @types/react@^19 @types/react-dom@^19
```

Expected: npm completes without errors. `package.json` shows `"next": "^15.x.x"`, `"react": "^19.x.x"`.

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0. If there are errors, read them carefully — they are almost certainly in files not covered by Tasks 1-4. Fix each error before continuing.

Common post-bump TypeScript errors and fixes:

| Error | Fix |
|---|---|
| `Type 'Promise<ReadonlyRequestCookies>' is not assignable` | You missed an `await cookies()` somewhere — search for other `cookies()` calls |
| `params.xxx` property access error | A dynamic route outside Tasks 3-4 still uses old-style params — add `await params` |
| `useFormState` not found | Replace with `useActionState` from `react` (not used in this codebase, but noting for completeness) |

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: 396 tests pass. If tests fail, diagnose before committing.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): upgrade to Next.js 15.2.4 + React 19"
```

---

### Task 6: Final verification

**Files:** None modified.

- [ ] **Step 1: Clean build**

```bash
cd C:\Users\coler\Desktop\vault-refactor\bron-vault && npm run build 2>&1 | tail -20
```

Expected: build completes successfully with no errors. Warnings about missing environment variables (`CLICKHOUSE_HOST` etc.) are expected outside Docker — the build still succeeds.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected:
```
Test Files  9 passed (9)
     Tests  396 passed (396)
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 4: Verify git log**

```bash
git log --oneline -7
```

Expected (most recent first):
```
<sha>  chore(deps): upgrade to Next.js 15.2.4 + React 19
<sha>  fix(breaches/retag): async params for Next.js 15 compatibility
<sha>  fix(breaches): async params for Next.js 15 compatibility
<sha>  fix(layout): await cookies() for Next.js 15 async request API
<sha>  chore(config): clean up deprecated Next.js 15 config options
```

- [ ] **Step 5: Push**

```bash
git push
```

- [ ] **Step 6: Rebuild Docker image on processing laptop**

After pulling on the Ubuntu processing laptop:

```bash
git pull
docker compose up -d --build
docker compose logs -f app | head -50
```

Expected: app starts, no `cookies()` sync warnings, no params-related errors in logs.
