import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/src/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 600_000,
    passWithNoTests: true,
    pool: 'forks',
    sequence: {
      concurrent: false,
    },
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
