# vMux Phase 4 — Test Safety Net Implementation Plan

> Execute task-by-task with spec + quality review (Opus) after each. Checkbox steps.

**Goal:** Establish a regression safety net: a coverage ratchet gate that can only go up, plus real tests covering the Phase 3a-extracted modules, the `sessions` store, and the most testable critical renderer component — so Phase 3b's risky refactors have a net.

**Architecture:** (1) **INTERIM** coverage gate at a conservative floor while Phase 4 runs — a global ratchet pinned at the start regresses transiently every time a new test imports a large under-covered file into the denominator (corrected design: the FINAL ratchet is a Phase-4-EXIT artifact, T6). (2) Pure-logic tests (node env): i18n engine, deeper `sessions` store. (3) Renderer test infra (`@testing-library/react` + `happy-dom`, env split) + a meaningful `CommandPalette` test **+ i18n hook tests** (`useT`/`useLocale`/`useI18n`) so `i18n/index.ts` is well-covered and the aggregate recovers. (4) T6 pins the FINAL ratchet at the true post-all-tests floor, which MUST end ≥ the original 60/47/56/66 baseline.

**Tech Stack:** Vitest 4, @vitest/coverage-v8, @testing-library/react, happy-dom, Zustand.

**Measured baseline (2026-05-19, whole repo):** Stmts 60.03 · Branch 47.53 · Funcs 56.52 · **Lines 66.04**. `sessions.ts`: lines 61 / funcs 39 (much uncovered). i18n engine: ~0 (no tests). `ipc-validation.ts`: 6 tests already.

**Scope note:** `TerminalPane.tsx` is NOT meaningfully unit-testable (xterm + WebGL + IPC bridge need a real GPU/canvas; jsdom/happy-dom can't). Its behavior will instead be covered by Phase 3b extracting pure hooks and testing THOSE. Phase 4 renderer testing targets `CommandPalette` (keyboard/filter logic — genuinely testable). This is documented, not skipped.

Spec: `docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md` (Phase 4).

---

### Task 1: Baseline guardrail
- [ ] `git status` clean on `chore/phase4-tests` (off `main`). `npm run typecheck` 0 · `npm run lint` 0 · `npm test` 135/12 · `npm run build` 0. Record. Red → BLOCKED.

---

### Task 2: Coverage ratchet gate (lock the floor)

**Files:** Modify `vitest.config.ts`; Modify `package.json` (add a `test:coverage` script if absent).

- [ ] **Step 1:** Run `npx vitest run --coverage` and record the EXACT current global %: lines, statements, functions, branches.
- [ ] **Step 2:** In `vitest.config.ts` add under `test`:
```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'html'],
  // RATCHET: thresholds pinned just below the current measured floor.
  // Rule: never lower these; raise them as coverage grows (Steps in later tasks).
  thresholds: {
    lines: <floor>,        // = floor(current_lines) - 1, e.g. 65
    statements: <floor>,   // = floor(current_statements) - 1
    functions: <floor>,    // = floor(current_functions) - 1
    branches: <floor>      // = floor(current_branches) - 1
  },
  exclude: [
    '**/__tests__/**', '**/*.config.*', 'out/**', 'release/**',
    'src/renderer/src/main.tsx', 'src/main/index.ts'
  ]
}
```
Replace each `<floor>` with `Math.floor(measured) - 1` from Step 1 (the −1 margin prevents flakiness from non-deterministic branch counting). These are a NO-REGRESSION lock, not an aspiration.
- [ ] **Step 3:** Ensure a script exists: `"test:coverage": "vitest run --coverage"` in package.json (add if missing; do not change `test`).
- [ ] **Step 4:** Run `npm run test:coverage` → MUST pass (thresholds met, since set below current). Paste the summary table + "passed" line. Run `npm test` → still 135/12. `npm run typecheck`/`lint`/`build` → green.
- [ ] **Step 5:** Commit:
```bash
git add vitest.config.ts package.json
git commit -m "test: coverage ratchet gate pinned at current floor

Lines/stmts/funcs/branches thresholds set just below measured baseline;
never lower, only ratchet up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: i18n engine tests (covers the Phase 3a extraction)

**Files:** Create `src/renderer/src/i18n/__tests__/i18n.test.ts`.

Note: vitest `include` is `src/**/__tests__/**/*.test.ts` — a test under `src/renderer/src/i18n/__tests__/` matches. The i18n engine functions to test are PURE / node-safe: `translate`, `interpolate` (internal — test via `translate` with vars), placeholder handling, and the Intl helpers `getNumberFormat`/`getPluralRules`/`getDateTimeFormat`/`getRelativeTimeFormat`. The React hooks (`useT`, `useLocale`, `useI18n`) require a renderer env — DO NOT test those here (Task 5 covers renderer infra; hooks are lower priority).

- [ ] **Step 1:** Read `src/renderer/src/i18n/index.ts` + `en.ts`. Identify the exact exported signatures of `translate`, `getNumberFormat`, `getPluralRules`, `getDateTimeFormat`, `getRelativeTimeFormat`, and how `EN`/`TKey` are exposed. Note: `translate` may take `(key, vars?, lang?)` — read the real signature.
- [ ] **Step 2:** Write `src/renderer/src/i18n/__tests__/i18n.test.ts` with REAL assertions for current behavior (characterization where behavior is subtle):
  - `translate` with a known `EN` key returns the English string.
  - `translate` with `{var}` interpolation substitutes vars; missing var → leaves placeholder or current behavior (READ code, assert reality).
  - `translate` with an unknown/forced-other lang falls back to `EN` (assert real fallback).
  - Each Intl helper returns a working formatter and is cached (call twice, assert same instance if the impl caches — READ `formatterCache` logic and assert true behavior).
  Aim ~6–10 `it` blocks. Every assertion must reflect the REAL implementation (read first). No behavior changes to source.
- [ ] **Step 3:** `npm test` → 135 + N new (all green; prior 135 unaffected). `npm run test:coverage` → still passes AND i18n line coverage materially up (paste i18n rows). `typecheck`/`lint`/`build` green.
- [ ] **Step 4:** Commit:
```bash
git add src/renderer/src/i18n/__tests__/i18n.test.ts
git commit -m "test(i18n): cover translate/interpolation/fallback + Intl helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `sessions` store deeper tests

**Files:** Modify `src/renderer/src/store/__tests__/sessions.test.ts` (exists).

- [ ] **Step 1:** Read `src/renderer/src/store/sessions.ts` and the existing `sessions.test.ts`. From the coverage report (`npx vitest run --coverage` → look at sessions.ts "Uncovered Line #s"), identify the untested actions/selectors (funcs coverage was ~39%). List the specific exported store actions with no/weak coverage.
- [ ] **Step 2:** Add `it` blocks to the existing test file covering the uncovered store actions with REAL behavior assertions (state transitions: create/select/remove/update/reorder/etc. — whatever the store exposes; read it). Use the store's existing test setup pattern in that file (mirror it — don't invent a new harness). Characterize true behavior; change no store logic.
- [ ] **Step 3:** `npm test` → all green (prior + new). `npm run test:coverage` → passes; `sessions.ts` funcs/lines materially up (paste row, before/after). `typecheck`/`lint`/`build` green.
- [ ] **Step 4:** Commit:
```bash
git add src/renderer/src/store/__tests__/sessions.test.ts
git commit -m "test(store): cover untested sessions store actions/selectors

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Renderer test infra + CommandPalette test

**Files:** Modify `package.json` (devDeps), `vitest.config.ts`; Create `src/renderer/src/test/setup.ts`; Create `src/renderer/src/components/__tests__/CommandPalette.test.tsx`.

- [ ] **Step 1:** Add devDeps (re-verify latest stable via `npm view`): `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `@testing-library/jest-dom`, `happy-dom`. `npm install` (no flags; ERESOLVE → BLOCKED).
- [ ] **Step 2:** vitest must run node tests AND renderer DOM tests. Use Vitest **projects** (or `environmentMatchGlobs`) so `.test.tsx` + `src/renderer/**` use `happy-dom` while existing `src/**/__tests__/**/*.test.ts` stay `node`. Update `vitest.config.ts`:
  - extend `include` to also match `**/__tests__/**/*.test.tsx`
  - renderer/tsx → `environment: 'happy-dom'`, `setupFiles: ['src/renderer/src/test/setup.ts']`
  - keep coverage config from Task 2 (do NOT lower thresholds)
  - keep `@shared` alias; add `@` alias (`resolve(__dirname,'src/renderer/src')`) so renderer imports resolve in tests
- [ ] **Step 3:** Create `src/renderer/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```
- [ ] **Step 4:** Read `src/renderer/src/components/CommandPalette.tsx` fully. Identify its props, how it opens, the command/filter source, and any store/IPC deps (mock the IPC bridge `window.api` / store as needed using the patterns already in the repo's tests; read an existing test for the mock style). Write `CommandPalette.test.tsx` with @testing-library: render it open, type a query, assert the filtered list updates, assert keyboard nav (Arrow/Enter) selects/invokes the expected command (assert the real handler is called via a mock). 3–6 meaningful `it` blocks asserting REAL behavior. If a hard dependency (xterm, webview, electron) makes a path untestable, test the tractable surface and note the boundary — do NOT fake behavior.

- [ ] **Step 4b: i18n hook tests** (recovers `i18n/index.ts` coverage, see Architecture note). Create `src/renderer/src/i18n/__tests__/i18n-hooks.test.tsx` using the new happy-dom infra + `@testing-library/react` `renderHook`. Read the real `useT`, `useLocale`, `useI18n` implementations (they subscribe to the i18n store / `useSessionStore` for lang). Mock the store/lang the same way the repo's existing tests do. Assert: `useT()` returns a working `t(key)` for the current lang; switching lang triggers re-render with the new translation (drive the store mock); `useLocale()`/`useI18n()` return the expected shape. 4–8 `it` blocks, REAL behavior, no faking. This is what lifts `index.ts` from ~48% so the T6 final ratchet lands ≥ baseline.
- [ ] **Step 5:** `npm test` → all prior + new green (node + happy-dom projects both run). `npm run test:coverage` → passes (thresholds still met; CommandPalette + components coverage up). `npm run typecheck` (the .tsx test must typecheck — ensure tsconfig picks it up or it's excluded from build but included for vitest; do NOT break `npm run build`). `npm run lint` 0 · `npm run build` 0. Paste key lines.
- [ ] **Step 6:** Commit:
```bash
git add package.json package-lock.json vitest.config.ts src/renderer/src/test/setup.ts src/renderer/src/components/__tests__/CommandPalette.test.tsx
git commit -m "test(renderer): @testing-library/happy-dom infra + CommandPalette tests

Vitest projects: node for main, happy-dom for renderer .tsx.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
If the infra proves too flaky/heavy to land cleanly after a genuine effort, STOP at the last green commit and report DONE_WITH_CONCERNS with specifics — partial-but-correct beats forced-and-flaky.

---

### Task 6: Re-ratchet + Phase 4 exit

**Files:** Modify `vitest.config.ts`; Modify the spec doc.

- [ ] **Step 1:** `npx vitest run --coverage` → record NEW global %. This is the FINAL ratchet point. Set `thresholds` in `vitest.config.ts` to `Math.floor(new_measured) - 1` for each metric. **HARD REQUIREMENT:** the new measured floor MUST be ≥ the original baseline (statements 60.03 / branches 47.53 / functions 56.52 / lines 66.04). If any metric is BELOW baseline, Phase 4's added tests did not sufficiently cover the source they pulled into the denominator — do NOT just pin lower; STOP and report (more hook/store coverage is needed, or a genuinely-untestable large file should be added to `coverage.exclude` with written justification). Replace the INTERIM comment with a FINAL ratchet comment ("never lower"). `npm run test:coverage` → passes at the new floor.
- [ ] **Step 2:** Final gate: typecheck (cache-busted) · lint 0 · `npm test` all green · `npm run test:coverage` pass · `npm run build` 0.
- [ ] **Step 3:** Update spec `## Phase 4` with a completion block: thresholds (before→after), new test counts, files covered, the documented TerminalPane boundary, and that Phase 3b is now unblocked (safety net exists).
- [ ] **Step 4:** Commit (config + docs):
```bash
git add vitest.config.ts docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md
git commit -m "test: ratchet coverage thresholds up; mark Phase 4 complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes
- Branch `chore/phase4-tests` (off `main`).
- Tests CHARACTERIZE real behavior — read source first; never modify source to make a test pass; never weaken a threshold.
- No `any`/`@ts-ignore`/`eslint-disable`/rule-downgrade in test code (eslint runs on `src/**/*.{ts,tsx}` incl. tests). Use proper typing/mocks.
- Coverage thresholds are a one-way ratchet: every later task may only raise them.
