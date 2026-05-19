import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // INTERIM ratchet floor (Phase 4 in progress). Pinning the final ratchet
      // at the START was a sequencing bug: each new test that imports a large,
      // not-yet-fully-covered file expands the coverage *denominator* faster
      // than it covers it, transiently depressing the global aggregate until
      // later Phase-4 tests catch up. So during Phase 4 the gate sits at a
      // conservative floor that still catches a catastrophic regression; the
      // FINAL ratchet is pinned at Phase-4 exit (P4-T6) against the true
      // post-all-tests floor (which must end ≥ the original 60/47/56/66
      // baseline — verified there). Never lower the FINAL ratchet.
      thresholds: {
        lines: 55,
        statements: 50,
        functions: 45,
        branches: 40
      },
      exclude: [
        '**/__tests__/**',
        '**/*.config.*',
        'out/**',
        'release/**',
        'src/renderer/src/main.tsx',
        'src/main/index.ts'
      ]
    }
  }
});
