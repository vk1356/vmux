# vMux Phase 1 — Quality Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ESLint operational and clean, tighten TypeScript (no unused locals/params), and eliminate the only real `any` usages — without changing runtime behavior.

**Architecture:** Add a single ESLint 10 flat config (`eslint.config.mjs`) with node vs browser file scoping, wire `lint` to run eslint + typecheck, flip `noUnusedLocals`/`noUnusedParameters` in both tsconfigs and fix the fallout, replace the 2 `any[]` signatures in `auto-updater.ts` with the lint-clean `never[]` storage pattern. The 16 existing `eslint-disable-next-line` comments are domain-legitimate (ANSI control-regex stripping, logger `no-console`, intentional `exhaustive-deps`) and are kept — the disable comment *is* the justification.

**Tech Stack:** ESLint 10.3.0 (flat config), typescript-eslint 8.59.2, @eslint/js 10.0.1, eslint-plugin-react-hooks 7.1.1, eslint-plugin-react-refresh 0.5.2, TypeScript 6.0.3, Vitest 4.

This is the first plan of a 5-phase roadmap. Spec: `docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md`. Phases 2-5 get their own plans once Phase 1 lands.

---

### Task 0: Capture baseline (guardrail)

**Files:** none (verification only)

- [ ] **Step 1: Verify typecheck is green**

Run: `npm run typecheck`
Expected: exits 0, no errors. If it fails, STOP — fix or report before proceeding (this plan assumes a green baseline).

- [ ] **Step 2: Verify tests are green**

Run: `npm test`
Expected: all suites pass (11 test files). Record the pass count.

- [ ] **Step 3: Verify app boots**

Run: `npm run dev` then close it after the window appears (Ctrl+C).
Expected: Electron window opens with no console errors. This is the smoke baseline reused at every phase exit.

---

### Task 1: Add `globals` dev dependency

**Files:**
- Modify: `package.json` (devDependencies)

- [ ] **Step 1: Install `globals`**

`eslint.config.mjs` needs the `globals` package for node/browser environment globals. It is currently NOT installed.

Run: `npm install -D globals`
Expected: `globals` appears in `devDependencies`, install succeeds.

- [ ] **Step 2: Verify it resolves**

Run: `node -e "import('globals').then(g => console.log(typeof g.default.node, typeof g.default.browser))"`
Expected: `object object`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(lint): add globals devDep for flat eslint config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Create the ESLint flat config

**Files:**
- Create: `eslint.config.mjs`

- [ ] **Step 1: Write `eslint.config.mjs`**

Type-checked linting is intentionally NOT enabled (no `parserOptions.project`): the rules we need (`no-explicit-any`, `no-console`, react-hooks) are syntactic, and typed linting adds cost and config fragility for zero gain here.

```js
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'dist/**',
      'node_modules/**',
      '*.config.{js,mjs,ts}',
      'electron.vite.config.ts',
      'vitest.config.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
);
```

- [ ] **Step 2: Run ESLint and observe the real state**

Run: `npx eslint "src/**/*.{ts,tsx}"`
Expected: ESLint executes successfully (config valid) and reports **0 errors**. All 18 escape-hatch sites (the 2 `any[]` in `auto-updater.ts` and the 16 others) currently carry an `eslint-disable-next-line` comment, so nothing errors yet. Warnings may appear only where a rule is `warn` and not disabled. If ESLint itself crashes (bad config / bad import), fix the config before continuing.

- [ ] **Step 3: Confirm the config is clean and the rule is wired**

Run: `npx eslint "src/**/*.{ts,tsx}" --report-unused-disable-directives`
Expected: still 0 errors. This flag would flag a stale disable directive — none should appear yet (every disable currently suppresses a real finding). This confirms `@typescript-eslint/no-explicit-any` is active and the disables are load-bearing. Task 4 removes the 2 `any` disables by removing the `any` itself.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): add ESLint 10 flat config (node/browser scoped)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire `lint` to eslint + typecheck

**Files:**
- Modify: `package.json:29-30` (scripts)

- [ ] **Step 1: Update the scripts**

Current:
```json
"lint": "npm run typecheck",
"lint:eslint": "eslint \"src/**/*.{ts,tsx}\"",
```
Replace with:
```json
"lint:eslint": "eslint \"src/**/*.{ts,tsx}\"",
"lint": "npm run lint:eslint && npm run typecheck",
```

- [ ] **Step 2: Run the combined lint**

Run: `npm run lint`
Expected: `lint:eslint` runs first (0 errors, since all `any` is still disable-suppressed at this point), then `npm run typecheck` runs and also passes. Exit 0. This proves the two stages are wired in order. The genuine type-safety improvement happens in Task 4 (removing the `any` + its now-unnecessary disable).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(lint): lint script now runs eslint + typecheck

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Eliminate the 2 real `any[]` signatures

**Files:**
- Modify: `src/main/auto-updater.ts:53-57` and `:118-122`
- Test: `npm run lint:eslint`, `npm run typecheck`, `npm test`

Rationale: both sites currently use `any[]` *suppressed by an `eslint-disable-next-line`* — lint is quiet but the types are still unsafe. Goal: remove the `any` (genuine type safety) AND the now-pointless disable comment. Both sites store heterogeneous callbacks; the lint-clean, type-safe replacement for "a variable that can hold any function" is `(...args: never[]) => R` — a bivariance-safe bottom signature that accepts any function without `any`. The replacement code blocks below intentionally omit the `// eslint-disable-next-line` line. The existing `removeListener` cast (lines 95-99) already uses `unknown[]` and is unaffected.

- [ ] **Step 1: Replace the `updaterListeners` element type**

In `src/main/auto-updater.ts`, change lines 53-57 from:
```ts
const updaterListeners: Array<{
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (...args: any[]) => void;
}> = [];
```
to:
```ts
const updaterListeners: Array<{
  event: string;
  fn: (...args: never[]) => void;
}> = [];
```

- [ ] **Step 2: Replace the `registerIpcHandler` handler type**

In the same file, change lines 118-122 from:
```ts
function registerIpcHandler(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Promise<unknown> | unknown
): void {
```
to:
```ts
function registerIpcHandler(
  channel: string,
  handler: (...args: never[]) => Promise<unknown> | unknown
): void {
```

- [ ] **Step 3: Typecheck — fix any fallout at call sites**

Run: `npm run typecheck`
Expected: PASS. If a caller pushes/passes a typed handler that TS now rejects against `never[]`, that means the call site relied on `any` widening — wrap the registration argument with an explicit cast at the call site only (`handler as (...args: never[]) => unknown`) rather than reintroducing `any` in the shared signature. Re-run until green.

- [ ] **Step 4: Lint must now be clean of errors**

Run: `npm run lint:eslint`
Expected: exit 0 for errors (warnings may remain and are acceptable). Specifically: zero `@typescript-eslint/no-explicit-any` errors.

- [ ] **Step 5: Tests still green**

Run: `npm test`
Expected: same pass count as Task 0 Step 2 (auto-updater has dedicated tests in `src/main/__tests__/auto-updater.test.ts` — they must still pass).

- [ ] **Step 6: Commit**

```bash
git add src/main/auto-updater.ts
git commit -m "fix(types): replace any[] callback signatures with never[]

Lint-clean, type-safe storage for heterogeneous updater/IPC handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Enable `noUnusedLocals` / `noUnusedParameters`

**Files:**
- Modify: `tsconfig.web.json` (compilerOptions)
- Modify: `tsconfig.node.json` (compilerOptions)
- Modify: source files reported by the compiler (discovered in Step 2)

- [ ] **Step 1: Flip the flags in both tsconfigs**

In `tsconfig.web.json`, change:
```json
"noUnusedLocals": false,
```
to:
```json
"noUnusedLocals": true,
"noUnusedParameters": true,
```
Apply the identical change in `tsconfig.node.json` (it also has `"noUnusedLocals": false`).

- [ ] **Step 2: Run typecheck to enumerate the fallout**

Run: `npm run typecheck`
Expected: a finite list of `TS6133` ("declared but never read") / `TS6196` errors. Capture the full list — this is the work queue for Step 3.

- [ ] **Step 3: Fix each reported error**

For every `TS6133`/`TS6196`:
- If it is a genuinely unused local/import → delete it.
- If it is an intentionally-unused function parameter that must stay for signature/position reasons → prefix with `_` (the ESLint `no-unused-vars` rule from Task 2 already ignores `^_`, keeping eslint and tsc consistent).
- Do NOT suppress with `// @ts-expect-error` or `any`.

Re-run `npm run typecheck` after each file until it exits 0.

- [ ] **Step 4: Full gate**

Run: `npm run lint`
Expected: exit 0 (eslint errors = 0, typecheck = 0).

Run: `npm test`
Expected: same pass count as Task 0.

- [ ] **Step 5: App boots (smoke)**

Run: `npm run dev`, confirm the window opens with no new console errors, close it.
Expected: identical behavior to Task 0 Step 3.

- [ ] **Step 6: Commit**

```bash
git add tsconfig.web.json tsconfig.node.json src/
git commit -m "chore(ts): enable noUnusedLocals + noUnusedParameters, clean fallout

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Phase 1 exit

**Files:** none (verification + handoff)

- [ ] **Step 1: Final phase-exit gate**

Run, in order, and confirm each:
- `npm run lint` → exit 0
- `npm test` → all green, pass count == Task 0
- `npm run dev` → window opens clean, then close

- [ ] **Step 2: Confirm escape-hatch inventory**

Run: `git grep -n "eslint-disable\|: any\|as any" -- "src/**/*.ts" "src/**/*.tsx"`
Expected: zero `: any` / `as any`; the remaining `eslint-disable-next-line` lines are exactly the 16 domain-legitimate ones (control-regex ANSI stripping, logger/i18n `no-console`, intentional `exhaustive-deps`, `react/no-unknown-property` for the webview attr). Each already carries its justifying disable comment — this is the accepted end state, not debt.

- [ ] **Step 3: Update spec status**

In `docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md`, mark Phase 1 done (add `**Phase 1: COMPLETE (2026-..)**` under the Phase 1 heading).

- [ ] **Step 4: Commit + report**

```bash
git add docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md
git commit -m "docs(spec): mark Phase 1 (quality foundations) complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Report Phase 1 done. The project release workflow (commit → push → bump semver → `npm run release`) is owned by the user and run by them when they choose to ship this phase. Phase 2 (deps → stable-latest) gets its own plan next.

---

## Notes for the implementer

- **Branch:** all Phase 1 work lands on `chore/360-quality-roadmap` (already created and holding the spec commit).
- **Never** reintroduce `any` or `@ts-ignore` to make a step pass — that defeats the entire phase.
- **Behavior must not change.** This phase is tooling + types only. If a fix would alter runtime behavior, stop and flag it.
- The 16 `eslint-disable-next-line` are intentional and stay. Do not "clean" them by rewriting working ANSI/logger code.
