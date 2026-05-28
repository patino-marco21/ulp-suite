# Next.js 15 Upgrade — Design Spec

## Goal

Upgrade from Next.js 14.2.35 to Next.js 15.2.4 (latest stable) to patch the May 2026 CVE batch (DoS, SSRF, XSS in App Router + CSP nonces) that will not be backported to 14.x. Bring React to 19 as required by Next.js 15.

---

## Background

Next.js 14.x received no security patches for the May 2026 release. This project uses App Router with CSP headers (`next.config.mjs`) making the XSS advisory directly relevant. The migration scope is small: most dynamic routes already use the Next.js 15 async `params` pattern, and `cookies()` is called in only one file.

---

## Migration Strategy

Manual, code-first. Make all source changes while still on Next.js 14 (so `tsc` stays green throughout), then bump dependencies in a single commit. This makes the dependency bump diff trivially reviewable and isolates any build-time surprise to one commit.

---

## Section 1 — Dependency Bump

**`package.json` changes:**

| Package | From | To |
|---|---|---|
| `next` | `^14.2.35` | `^15.2.4` |
| `react` | `^18` | `^19` |
| `react-dom` | `^18` | `^19` |
| `eslint-config-next` | `^14.2.35` | `^15.2.4` |
| `@types/react` (dev) | `^18` | `^19` |
| `@types/react-dom` (dev) | `^18` | `^19` |

**Command:**
```bash
npm install next@^15.2.4 react@^19 react-dom@^19 eslint-config-next@^15.2.4
npm install --save-dev @types/react@^19 @types/react-dom@^19
```

No other dependencies need changing. Radix UI, Tailwind, better-sqlite3, ClickHouse JS client, Vitest, and all other deps are React-version-agnostic or already compatible with React 19.

---

## Section 2 — next.config.mjs Cleanup

Three config options are deprecated or removed in Next.js 15:

| Old | New | Reason |
|---|---|---|
| `experimental.instrumentationHook: true` | Remove entirely | Stable in 15, no flag needed |
| `experimental.serverComponentsExternalPackages: ['better-sqlite3']` | `serverExternalPackages: ['better-sqlite3']` (top-level) | Promoted out of experimental |
| `swcMinify: true` | Remove entirely | On by default in 15, option removed |

The `experimental.webpackBuildWorker: false` and `experimental.outputFileTracingExcludes` options remain (still valid in 15).

---

## Section 3 — Async cookies() in app/layout.tsx

**File:** `app/layout.tsx`

Next.js 15 makes `cookies()` (and `headers()`, `draftMode()`) return a Promise. The synchronous call at line 48 must be awaited.

**Change:**
```ts
// Before
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = cookies()

// After
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
```

---

## Section 4 — Async params in Breaches Routes

Two files still type `params` as a plain object (not Promise). Next.js 15 passes `params` as a Promise; accessing it synchronously works in 14 but triggers a warning in 15 and will break in 16.

**Files:**
- `app/api/breaches/[name]/route.ts` — 3 handlers (GET, PATCH, DELETE)
- `app/api/breaches/[name]/retag/route.ts` — 1 handler (POST)

**Pattern for each handler:**

```ts
// Before
export async function GET(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  const { name } = params

// After
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params
```

All other dynamic routes (`monitoring/monitors/[id]`, `monitoring/webhooks/[id]`, `v1/api-keys/[id]`, `upload/progress/[jobId]`) already use the Promise pattern — no changes needed.

---

## Section 5 — Testing

**Automated:**
- All 396 existing Vitest tests must continue to pass after each code change and after the dependency bump.
- `npx tsc --noEmit` must exit 0 at every stage.

**Manual smoke tests (after Docker rebuild):**
- `/api/breaches` — verify GET, PATCH, DELETE routes return correct responses
- `/api/breaches/[name]/retag` — verify POST route works
- Layout `user_role` cookie — verify sidebar renders correctly (SSR cookie read still works)
- Upload a `.txt` file — verify SSE progress still streams
- Admin login / logout — verify auth cookie flow unchanged

---

## File Map

| File | Change |
|---|---|
| `package.json` | Bump next, react, react-dom, eslint-config-next, @types/react, @types/react-dom |
| `next.config.mjs` | Remove `instrumentationHook`, move `serverComponentsExternalPackages` → `serverExternalPackages`, remove `swcMinify` |
| `app/layout.tsx` | `function` → `async function`, `cookies()` → `await cookies()` |
| `app/api/breaches/[name]/route.ts` | 3 handlers: `params: Promise<{name}>` + `await params` |
| `app/api/breaches/[name]/retag/route.ts` | 1 handler: `params: Promise<{name}>` + `await params` |

**5 files total. No new files. No database changes.**
