# vMux Phase 3a — Safe God-File Extractions Implementation Plan

> Execute task-by-task with characterization-test-first, then spec + quality review. Checkbox steps.

**Goal:** Shrink two god-files via LOW-RISK, behavior-preserving extractions that match the spec's intent ("separate i18n locale data from engine"; decompose `ipc.ts`).

**Architecture:** (1) Move the `EN` translation catalog out of `i18n/index.ts` into its own data module. (2) Extract `ipc.ts`'s pure stateless validation/guard helpers into `ipc-validation.ts`. Both are mechanical moves of self-contained code with no state — verified by full gate + (for ipc) new characterization tests on the extracted pure functions.

**Tech Stack:** TypeScript, Vite glob imports, Vitest.

**Risk-based scope note:** `pty-manager.ts` and `TerminalPane.tsx` are deliberately DEFERRED to Phase 3b (after the Phase 4 test safety net) — refactoring untested stateful/UI code without a regression net is unsafe. Recorded in the spec.

Spec: `docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md` (Phase 3).

---

### Task 1: Baseline guardrail

- [ ] `git status` clean on `chore/phase3-refactor` (off `main`). `npm run typecheck` 0, `npm run lint` 0, `npm test` 129/11, `npm run build` 0. Record. Red → BLOCKED.

---

### Task 2: Extract i18n `EN` catalog → `i18n/en.ts`

**Files:**
- Create: `src/renderer/src/i18n/en.ts`
- Modify: `src/renderer/src/i18n/index.ts`

Current: `src/renderer/src/i18n/index.ts` lines ~8–450 define `const EN = { ... }` (the English source catalog). `TKey` is `keyof typeof EN` (line ~451). `loaded` seeds `{ en: EN as LocaleCatalog }` (~482). The Vite `import.meta.glob` LOCALE_LOADERS (~476) loads OTHER locales from `./locales/*`.

- [ ] **Step 1:** Read `src/renderer/src/i18n/index.ts` fully. Identify the exact line range of `const EN = { ... };` (from `const EN = {` through its closing `};`).

- [ ] **Step 2:** Create `src/renderer/src/i18n/en.ts` containing exactly:
```ts
// English source catalog — the single source of truth for translation keys.
// Extracted from index.ts so the i18n engine and its data live separately.
export const EN = {
  // ...EXACT object body moved verbatim from index.ts...
} as const;

export type TKey = keyof typeof EN;
```
Move the `EN` object body VERBATIM (do not edit a single key/value). Move the `export type TKey = keyof typeof EN;` declaration here too (it belongs with the data). Preserve `as const` if present in the original; if the original had `const EN = { ... };` without `as const`, keep it identical (do NOT add `as const` — that would change `TKey`/types). Match the original exactly.

- [ ] **Step 3:** In `index.ts`: remove the `const EN = {...}` block and the `export type TKey = ...` line; add at the top `import { EN, type TKey } from './en';` and re-export the type so existing importers keep working: `export type { TKey } from './en';` (verify how `TKey` is currently exported from index.ts — replicate the SAME export surface so no other file breaks). Keep every other line of `index.ts` unchanged (loaders, `loaded` seed `{ en: EN as LocaleCatalog }`, interpolate, translate, hooks, Intl formatters).

- [ ] **Step 4:** Verify no consumer broke. Run:
  - `git grep -n "from '@/i18n'" -- src | head` and `git grep -n "i18n/index\|from './index'\|TKey" -- src/renderer` to confirm the public surface (`EN`? `TKey`? `translate`, `useT`, etc.) is unchanged. If any file imported `EN` directly from index, ensure index still re-exports it (`export { EN } from './en';`) — match the prior surface exactly.

- [ ] **Step 5: Gate** (all must pass; paste key line):
  - `rm -f tsconfig.node.tsbuildinfo tsconfig.web.tsbuildinfo && npm run typecheck` → 0 (this proves `TKey` and all key references still resolve identically)
  - `npm run lint` → 0 errors
  - `npm test` → 129/11
  - `npm run build` → 0; then `node -e "const fs=require('fs');const a=fs.readdirSync('out/renderer/assets');console.log(a.filter(f=>/en|i18n|index/.test(f)).join(','))"` (sanity that renderer built)
  - Confirm `wc -l src/renderer/src/i18n/index.ts` is now ≪ 771 and `en.ts` holds the catalog.

- [ ] **Step 6: Commit**
```bash
git add src/renderer/src/i18n/en.ts src/renderer/src/i18n/index.ts
git commit -m "refactor(i18n): extract EN catalog to en.ts (data/engine split)

Behavior-preserving: EN object + TKey moved verbatim; index.ts re-exports
the same public surface. No key/value changed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Extract `ipc.ts` pure validation guards → `ipc-validation.ts`

**Files:**
- Create: `src/main/ipc-validation.ts`
- Create: `src/main/__tests__/ipc-validation.test.ts`
- Modify: `src/main/ipc.ts`

Current: `src/main/ipc.ts` lines ~56–289 are pure, stateless helpers/constants: `MAX_*` consts, `isNonEmptyString`, `isString`, `isId`, `isValidPtySize`, `isUnsafePath`, `safePath`, `isHttpUrl`, `isSplitDirection`, `ALLOWED_SETTINGS_KEYS`, `sanitizeSettingsPatch`, `isValidMcpServer`, `isValidSnippet`, `isValidCreateSessionInput`, `isValidSplitPaneInput`, `isValidTreePath`, `isValidSizesArray`, `VALID_LAYOUT_PRESETS`, `isValidLayoutPreset`. (`isTrustedSender` at ~289 uses Electron sender APIs — KEEP it in ipc.ts, it is not a pure data guard. `safe`/`throttle` at ~313/328 — KEEP in ipc.ts, they're handler infra.) `registerIpc` (~355+) consumes these guards.

- [ ] **Step 1:** Read `ipc.ts` lines 1–360. List EXACTLY which of the above helpers/consts are pure (no Electron/`ptyManager`/module-state dependency) and used only as input validation. Confirm the cut line: everything from the first `MAX_STRING_LEN` const through `isValidLayoutPreset` that is pure. Note every type these helpers reference (e.g. `PtySize`, `AppSettings`, `McpServer`, `Snippet`, `CreateSessionInput`, `SplitPaneInput`, `TreePath`, `LayoutPreset`, `SplitDirection`) — they import from `@shared/types`.

- [ ] **Step 2:** Create `src/main/ipc-validation.ts`: move the identified pure consts + guard functions VERBATIM. Add the necessary `import type { ... } from '@shared/types';` at top (copy the exact type names used). `export` every symbol that `ipc.ts` still needs (all the `isX`/`safePath`/`sanitizeSettingsPatch`/`MAX_*` used by `registerIpc`).

- [ ] **Step 3:** In `ipc.ts`: delete the moved block; add `import { isId, isString, isNonEmptyString, safePath, isHttpUrl, isValidPtySize, isSplitDirection, sanitizeSettingsPatch, isValidMcpServer, isValidSnippet, isValidCreateSessionInput, isValidSplitPaneInput, isValidTreePath, isValidSizesArray, isValidLayoutPreset, MAX_STRING_LEN, MAX_CLIPBOARD_LEN, MAX_ID_LEN, MAX_LABEL_LEN } from './ipc-validation';` — adjust this import list to EXACTLY the symbols actually referenced in the remaining `ipc.ts` (typecheck will tell you; remove unused, add missing). Remove now-unused `@shared/types` type imports from ipc.ts only if they became unused (noUnusedLocals will flag them).

- [ ] **Step 4: Characterization tests** — create `src/main/__tests__/ipc-validation.test.ts` with real assertions for the security-critical guards (these protect the IPC boundary; tests lock current behavior):
```ts
import { describe, it, expect } from 'vitest';
import {
  isId, isHttpUrl, safePath, isValidPtySize, sanitizeSettingsPatch
} from '../ipc-validation';

describe('ipc-validation guards (characterization)', () => {
  it('isId accepts a normal id, rejects empty/oversized/non-string', () => {
    expect(isId('sess_abc-123')).toBe(true);
    expect(isId('')).toBe(false);
    expect(isId(123 as unknown)).toBe(false);
    expect(isId('x'.repeat(10_000))).toBe(false);
  });
  it('isHttpUrl accepts http/https, rejects other schemes', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://localhost:3000')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl(42 as unknown)).toBe(false);
  });
  it('safePath rejects traversal / non-string, returns string or null', () => {
    expect(safePath(123 as unknown)).toBeNull();
    expect(safePath('../../etc/passwd')).toBeNull();
    const ok = safePath('C:/Users/me/project');
    expect(ok === null || typeof ok === 'string').toBe(true);
  });
  it('isValidPtySize requires positive integer cols/rows', () => {
    expect(isValidPtySize({ cols: 80, rows: 24 })).toBe(true);
    expect(isValidPtySize({ cols: 0, rows: 24 })).toBe(false);
    expect(isValidPtySize({ cols: -1, rows: 24 })).toBe(false);
    expect(isValidPtySize({} as unknown)).toBe(false);
  });
  it('sanitizeSettingsPatch drops unknown keys', () => {
    const out = sanitizeSettingsPatch({ notAKey: 1 } as unknown);
    expect(Object.keys(out)).not.toContain('notAKey');
  });
});
```
Adjust ONLY if a guard's real signature/behavior differs from the assumption above — first READ the actual implementation, then make each assertion reflect TRUE current behavior (characterization = lock what IS, not what should be). If `safePath`/`isValidPtySize` semantics differ, rewrite that test to match reality and note it.

- [ ] **Step 5: Gate** (all must pass; paste key line):
  - `rm -f *.tsbuildinfo && npm run typecheck` → 0
  - `npm run lint` → 0 errors; `npx eslint "src/**/*.{ts,tsx}" --report-unused-disable-directives` → 0 errors, no stale
  - `npm test` → now **134/12** (129 prior + 5 new ipc-validation tests, 1 new file). Confirm the new file is collected and the prior 129 still pass.
  - `npm run build` → 0
  - `wc -l src/main/ipc.ts` → meaningfully < 836.

- [ ] **Step 6: Commit**
```bash
git add src/main/ipc-validation.ts src/main/__tests__/ipc-validation.test.ts src/main/ipc.ts
git commit -m "refactor(ipc): extract pure validation guards to ipc-validation.ts

Stateless guards moved verbatim + characterization tests for the
security-critical ones. ipc.ts now imports them; behavior unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Phase 3a exit

- [ ] **Step 1:** Final gate: typecheck (cache-busted) · lint 0 · `npm test` 134/12 · build — all green.
- [ ] **Step 2:** Update spec: under `## Phase 3` add a block recording 3a complete (i18n `EN`→`en.ts`; ipc guards→`ipc-validation.ts` +5 tests; new line counts) and that **3b (pty-manager.ts, TerminalPane.tsx) is intentionally deferred to after Phase 4** so the test safety net exists before refactoring untested stateful/UI code (cite the spec's own "characterization tests before extraction" risk mitigation).
- [ ] **Step 3:** Commit (docs only):
```bash
git add docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md
git commit -m "docs(spec): Phase 3a complete; 3b deferred post-Phase-4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes
- Branch `chore/phase3-refactor` (off `main`).
- VERBATIM moves only — no key/value/logic edits during extraction. The whole point is zero behavior change; the gate (typecheck proves type identity, tests prove behavior) is the proof.
- No `any`/`@ts-ignore`/`eslint-disable`/rule-downgrade. If an extraction surfaces a real issue, STOP and report — don't mask.
