import { defineConfig } from 'vitest/config'

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
    // Coverage (run with --coverage)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['lib/ulp-parser.ts', 'lib/ulp-search.ts'],
    },
  },
})
