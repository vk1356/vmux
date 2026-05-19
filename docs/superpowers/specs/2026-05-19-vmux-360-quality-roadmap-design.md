# vMux — 360° Quality Roadmap (Design)

**Date:** 2026-05-19
**Status:** Approved (pending written-spec review)
**Project:** vmux-windows v0.7.8 — Electron multi-agent AI orchestrator

## Goal

Bring the entire codebase to a "perfect, latest" state through a phased,
reversible quality roadmap. Each phase is independently shippable and gated on
typecheck + tests green + app boots.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Scope | Full 360° quality audit (deps, type-safety, architecture, tests, perf/a11y) |
| Version risk | Stable-latest only — zero pre-release in production |
| Execution | Phased roadmap (5 phases), one concern at a time |
| electron-vite | Downgrade `^6.0.0-beta.1` → `5.0.0` stable |

## Baseline (measured 2026-05-19)

- ~22,856 LOC, 93 TS/TSX files, 11 test files.
- Electron security posture already solid: `contextIsolation:true`, `sandbox`
  enforced on webview at attach time, no raw `ipcRenderer` exposed in preload.
- Dependencies already ~95% at latest stable. Only real gap: `electron-vite`
  on a beta (latest stable = 5.0.0).
- ESLint **not operational**: `lint:eslint` script exists but no
  `eslint.config.*` flat config file present. `lint` = typecheck only.
- `noUnusedLocals:false` in both tsconfigs; ~40 typing escape hatches
  (`as any`, `: any`, 16 `eslint-disable-next-line`).
- God-files: `pty-manager.ts` (1123L, ~25 methods, mixed responsibilities),
  `ipc.ts` (836L), `TerminalPane.tsx` (776L), `i18n/index.ts` (771L).
- Tests concentrated on main-process detectors; renderer/components and most
  of the `sessions` store untested. No coverage thresholds in vitest config.

## Non-goals (YAGNI)

UI rewrite, new features, framework migration, `skipLibCheck:false`, CI/CD
changes (unless separately requested), unrelated refactoring.

---

## Phase 0 — Guardrails

- Record baseline: `npm run typecheck && npm test` must pass; capture output.
- One git branch per phase; never mix refactor with dependency bumps.
- **Phase exit criteria (every phase):** typecheck green, tests green, app
  boots (`npm run dev` smoke), no new ESLint errors.

## Phase 1 — Quality Foundations

**Phase 1: COMPLETE (2026-05-19).** Verified end state:
- ESLint operational (flat config, strict — `recommended` rules at full strength, no stubs, no downgrades); `lint` = eslint + typecheck.
- `noUnusedLocals` + `noUnusedParameters` enabled in both tsconfigs.
- Zero `any` / `@ts-ignore` / `@ts-expect-error` in src (the 2 real `auto-updater.ts` `any[]` replaced with `never[]`).
- Remaining `eslint-disable` directives: 17 — all load-bearing (verified via --report-unused-disable-directives), domain-legitimate (ANSI/control-regex, logger no-console, intentional exhaustive-deps, TS control-flow no-useless-assignment).
- Gates: typecheck ✅ (cache-busted), lint ✅ 0 errors, tests ✅ 129/11, build ✅.
- `eslint-plugin-react` was NOT adopted (the only react/* disable was removable); `esbuild@^0.27` added as explicit devDep to keep the build hoist stable after lockfile re-solve.

1. Author a real `eslint.config.mjs` (ESLint 10 flat config) wiring
   `typescript-eslint` 8, `eslint-plugin-react-hooks`,
   `eslint-plugin-react-refresh`, with main/preload vs renderer overrides.
2. Make `lint` run `eslint` **and** `typecheck` (not typecheck alone).
3. Enable `noUnusedLocals:true` + `noUnusedParameters:true` in
   `tsconfig.web.json` and `tsconfig.node.json`; remove dead bindings.
4. Resolve the ~40 typing escape hatches case-by-case: properly type, or keep
   with a justifying comment where genuinely unavoidable.
5. Keep `skipLibCheck:true` (flipping it is high-noise, low-value — out of scope).

**Exit:** ESLint runs clean on `src/**`, stricter tsconfig green, escape-hatch
count documented and minimized.

## Phase 2 — Dependencies → stable-latest

1. Re-verify every target version against the npm registry at execution time
   (registry is source of truth — never training memory).
2. Safe patch/minor bumps: electron 42.1.0, vite 8.0.13, eslint 10.4.0,
   typescript-eslint 8.59.4, vitest 4.1.6, lucide-react 1.16.0,
   @types/node 25.9.0 (subject to re-check).
3. `electron-vite` `^6.0.0-beta.1` → `5.0.0`: migrate
   `electron.vite.config.ts` if the v6→v5 API differs; verify build + dev +
   package still work.
4. Run full typecheck + tests + dev smoke after each cluster of bumps.

**Exit:** zero pre-release deps, all stable-latest, build/dev/package green.

## Phase 3 — God-file refactor

Rule: one file per PR, behavior unchanged, characterization tests written
**before** extraction.

- `pty-manager.ts` → extract single-responsibility modules (agent-state
  detection, URL detection if not already separate, pane persistence,
  heartbeat); `PtyManager` becomes a thin orchestrator.
- `ipc.ts` → split handlers by domain (window / sessions / agents / mcp / …).
- `TerminalPane.tsx` → extract hooks (`useXterm`, `usePaneIpc`, …).
- `i18n/index.ts` → separate locale data from the i18n engine.

**Exit:** no source file > ~400L without a documented reason; each extracted
module has a clear name, interface, and dependency set; behavior identical.

## Phase 4 — Test safety net

1. Add coverage thresholds to `vitest.config.ts` — progressive gate (start
   ~60% lines, ratchet up; never lower).
2. Cover missing paths in the `sessions` store.
3. Add renderer tests for critical components (TerminalPane, CommandPalette)
   via @testing-library.
4. Regression tests for each module extracted in Phase 3.

**Exit:** coverage gate enforced in CI/test run; critical renderer paths tested.

## Phase 5 — Residual perf / a11y / robustness

Targeted pass on gaps not already covered by the v0.7.x audit commits: IPC
error handling, node-pty edge cases (spawn failure, child death races), focus
management, color contrast. Scope confirmed against current state before work.

**Exit:** identified residual issues fixed or explicitly deferred with rationale.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| electron-vite 6→5 breaks build config | Isolated in Phase 2; measure API diff; revert branch if unrecoverable |
| Refactor introduces regressions | Characterization tests before extraction; one file per PR |
| Stricter tsconfig surfaces large fallout | Phase 1 dedicated to it; fix incrementally before later phases |
| "Latest" expectation vs reality | Documented: deps already ~95% latest; value is quality/architecture |

## Success Criteria

- ESLint operational and clean; `lint` = eslint + typecheck.
- `noUnusedLocals`/`noUnusedParameters` on; escape hatches minimized.
- All deps stable-latest, zero pre-release.
- No unexplained source file > ~400L; god-files decomposed.
- Coverage gate enforced; critical renderer paths tested.
- Every phase: typecheck + tests green + app boots.
