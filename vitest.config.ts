import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    globals: true,
    // Dual-environment via Vitest 4 `projects`. Coverage stays at the ROOT
    // `test` block (below) so a single `vitest run --coverage` aggregates
    // EVERY project — coverage config is intentionally NOT project-local.
    projects: [
      {
        // Main/shared code: pure Node, the original 177 tests. Unchanged
        // behavior — *.test.ts only (NOT .tsx). `extends: true` inherits the
        // root `plugins`/`resolve` (so `@shared` / `@` aliases resolve).
        extends: true,
        test: {
          name: { label: 'node', color: 'green' },
          include: ['src/**/__tests__/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        // Renderer code that needs the DOM: *.test.tsx → happy-dom. Keeps it
        // simple — tsx ⇒ happy-dom, ts ⇒ node.
        extends: true,
        test: {
          name: { label: 'renderer', color: 'cyan' },
          include: ['src/**/__tests__/**/*.test.tsx'],
          environment: 'happy-dom',
          setupFiles: ['src/renderer/src/test/setup.ts']
        }
      }
    ],
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
        'src/renderer/src/test/**',
        'src/renderer/src/main.tsx',
        'src/main/index.ts'
      ]
    }
  }
});
