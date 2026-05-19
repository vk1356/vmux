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
      // RATCHET: pinned just below current measured floor. Never lower; only raise.
      thresholds: {
        lines: 65,
        statements: 59,
        functions: 55,
        branches: 46
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
