import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname.replace(/\/$/, ''),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // Print a summary line even for passing tests
    reporter: ['verbose'],
    // Don't collect tests from nested git worktrees — the legacy manual-fallback
    // location (.worktrees/hard-drop-t3/) and the native EnterWorktree tool's
    // location (.claude/worktrees/<name>/) both nest a full checkout (including
    // __tests__/) inside this repo; their copies otherwise surface as duplicate
    // runs / false failures in the main suite.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/.claude/worktrees/**'],
    // Isolated per-worker SQLite DB — see docs/superpowers/specs/2026-09-24-scale-audit-followups-design.md.
    // Without this, tests fall back to ./data/ulp.db: unwritable in the main
    // checkout (SQLITE_READONLY), and racy on first-admin-seed in a fresh
    // writable checkout.
    globalSetup: ['./__tests__/setup/sqlite-global-setup.ts'],
    setupFiles: ['./__tests__/setup/sqlite-worker-setup.ts'],
    // Coverage (run with --coverage)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['lib/ulp-parser.ts', 'lib/ulp-search.ts'],
    },
  },
})
