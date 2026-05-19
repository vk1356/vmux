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
      // FINAL ratchet (Phase 4 complete, 2026-05-19). Pinned at floor(measured)
      // − 1 of the post-all-tests coverage (195 tests / 15 files):
      // stmts 71.49 · branch 56.45 · funcs 74.57 · lines 76.39 — all well
      // above the original 60.03/47.53/56.52/66.04 baseline. This is a one-way
      // ratchet: NEVER lower these; raise them as coverage grows. CI fails if
      // coverage drops below. (The −1 margin absorbs v8 branch nondeterminism.)
      thresholds: {
        lines: 75,
        statements: 70,
        functions: 73,
        branches: 55
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
