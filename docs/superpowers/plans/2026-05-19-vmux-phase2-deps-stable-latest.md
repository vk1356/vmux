# vMux Phase 2 — Dependencies → Stable-Latest Implementation Plan

> **For agentic workers:** Execute task-by-task with spec + quality review after each. Checkbox (`- [ ]`) steps.

**Goal:** Bring every dependency to its latest STABLE version (zero pre-release in production), per the locked roadmap decision.

**Architecture:** Two clusters — (A) safe patch/minor bumps applied together; (B) the `electron-vite` 6-beta → 5.0.0 stable migration isolated on its own. Each cluster gated on typecheck + lint + tests + build green.

**Tech Stack:** npm, electron-vite, Vite 8, Electron 42, Vitest 4.

Spec: `docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md` (Phase 2). Versions below were verified against the npm registry on 2026-05-19; **re-verify at execution time** (`npm view <pkg> version`) — registry is source of truth.

Reconnaissance result: all deps already at latest stable EXCEPT the 10 patch/minors in Task 2 and the `electron-vite` pre-release in Task 3. `electron.vite.config.ts` already documents v5 semantics (`build.externalizeDeps` default, no v6-only API) → low migration risk.

---

### Task 1: Baseline guardrail

**Files:** none

- [ ] **Step 1:** `git status` clean on branch `chore/phase2-deps` (already created off `main`). Confirm `npm run typecheck` exit 0, `npm run lint` exit 0, `npm test` = 129/11, `npm run build` exit 0. Record. If any red → STOP/BLOCKED.

---

### Task 2: Safe patch/minor bumps (cluster A)

**Files:** Modify `package.json` (dependencies + devDependencies), `package-lock.json`.

- [ ] **Step 1: Re-verify latest stable for each, then set ranges**

Run `npm view <pkg> version` for each and set the caret range to that exact latest stable in `package.json`:

| package | section | from | to (re-verify) |
|---|---|---|---|
| electron | devDependencies | ^42.0.1 | ^42.1.0 |
| vite | devDependencies | ^8.0.11 | ^8.0.13 |
| eslint | devDependencies | ^10.3.0 | ^10.4.0 |
| typescript-eslint | devDependencies | ^8.59.2 | ^8.59.4 |
| electron-log | dependencies | ^5.4.3 | ^5.4.4 |
| vitest | devDependencies | ^4.1.5 | ^4.1.6 |
| @vitest/coverage-v8 | devDependencies | ^4.1.5 | ^4.1.6 |
| @vitejs/plugin-react | devDependencies | ^6.0.1 | ^6.0.2 |
| lucide-react | devDependencies | ^1.14.0 | ^1.16.0 |
| @types/node | devDependencies | ^25.6.2 | ^25.9.0 |

If a re-verified latest differs from the "to" column, use the re-verified value and note it. Do NOT touch any other dependency. Do NOT change `electron-vite` here (Task 3).

- [ ] **Step 2: Install**

Run: `npm install` (no flags — must resolve cleanly; if ERESOLVE appears, STOP/BLOCKED with the exact error — do NOT use --force/--legacy-peer-deps).
Expected: lockfile updates only for the bumped packages + their transitive deps.

- [ ] **Step 3: Full gate**

Run, all must pass (paste key line each):
- `rm -f tsconfig.node.tsbuildinfo tsconfig.web.tsbuildinfo && npm run typecheck` → exit 0
- `npm run lint` → exit 0, 0 errors
- `npx eslint "src/**/*.{ts,tsx}" --report-unused-disable-directives` → 0 errors, no stale directives (eslint 10.4 / tseslint 8.59.4 must not newly break or flag stale)
- `npm test` → 129 passed / 11 files
- `npm run build` → exit 0
- `npm ci --dry-run` → no ERESOLVE

If a tooling bump surfaces NEW lint/type errors (e.g. eslint 10.4 adds a rule, @types/node 25.9 tightens types): fix them properly (no `any`/`@ts-ignore`/`eslint-disable`/rule-downgrade). If the fallout is non-trivial or behavior-affecting → STOP and report DONE_WITH_CONCERNS with the full list.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): bump 10 deps to latest stable (patch/minor)

electron 42.1.0, vite 8.0.13, eslint 10.4.0, typescript-eslint 8.59.4,
electron-log 5.4.4, vitest+coverage 4.1.6, @vitejs/plugin-react 6.0.2,
lucide-react 1.16.0, @types/node 25.9.0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: electron-vite 6-beta → 5.0.0 stable (cluster B, isolated)

**Files:** Modify `package.json` (devDependencies), `package-lock.json`; possibly `electron.vite.config.ts` (only if v5 API differs).

- [ ] **Step 1: Re-verify & pin**

`npm view electron-vite version` → confirm latest stable (expected `5.0.0`; if a newer STABLE exists, use it; never a `-beta`/`-rc`). In `package.json` change `"electron-vite": "^6.0.0-beta.1"` → `"electron-vite": "^5.0.0"` (or the re-verified stable).

- [ ] **Step 2: Install**

Run: `npm install` (no flags). STOP/BLOCKED on ERESOLVE.

- [ ] **Step 3: Config compatibility check**

Read `electron.vite.config.ts`. It already targets v5 semantics (comment lines 8-10: `build.externalizeDeps` default; explicit `external: ['node-pty','pidusage']`; `defineConfig` from `electron-vite`; no `externalizeDepsPlugin`/v6-only imports). Confirm it still uses only APIs present in electron-vite 5.0.0 (`defineConfig`, `main/preload/renderer`, `resolve.alias`, `build.rollupOptions`, `server`). If any v6-only API is in use, migrate it to the v5 equivalent (consult electron-vite 5 docs via context7 if needed). If no change needed, state that explicitly — do NOT edit the file gratuitously.

- [ ] **Step 4: Build/dev/package verification (critical)**

All must pass (paste key line):
- `rm -f tsconfig.node.tsbuildinfo tsconfig.web.tsbuildinfo && npm run typecheck` → exit 0
- `npm run build` → exit 0; confirm `out/main/index.js`, `out/preload/index.js`, `out/renderer/index.html` produced
- `npm run lint` → exit 0
- `npm test` → 129 / 11
- `npm run package:dir` → exit 0 (electron-builder dir package; proves the v5 build output is packageable — this is the real proof the migration is safe). If `package:dir` is too slow/heavy or fails for a reason unrelated to electron-vite (e.g. code-signing), capture output and note; the build+typecheck+test gate is the minimum bar, package:dir is strongly preferred.
- `npm ci --dry-run` → no ERESOLVE

If the build/package fails due to electron-vite 5 API differences and Step 3 migration cannot resolve it cleanly → STOP, report BLOCKED with exact error (controller escalates per spec risk row: "electron-vite 6→5 breaks build config → measure API diff; revert branch if unrecoverable").

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts
git commit -m "chore(deps): electron-vite 6.0.0-beta -> 5.0.0 stable

Zero pre-release in production (roadmap decision). Config already
targeted v5 semantics; build/package verified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
(Omit `electron.vite.config.ts` from `git add` if Step 3 required no edit.)

---

### Task 4: Phase 2 exit

**Files:** Modify `docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md`.

- [ ] **Step 1: Zero-prerelease assertion**

Run: `node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies};const bad=Object.entries(d).filter(([k,v])=>/-(beta|rc|alpha|next|canary|dev|pre)/i.test(v));console.log(bad.length?JSON.stringify(bad):'NONE')"`
Expected: `NONE`. If anything prints, that dep is still pre-release → STOP/BLOCKED.

- [ ] **Step 2: Final gate** — `npm run typecheck` (cache-busted) · `npm run lint` · `npm test` 129/11 · `npm run build` all green. Paste key lines.

- [ ] **Step 3: Update spec**

Under `## Phase 2 — Dependencies → stable-latest` add a completion block (after the heading):
```
**Phase 2: COMPLETE (2026-05-19).** Verified end state:
- All dependencies at latest STABLE; zero pre-release (asserted programmatically).
- 10 patch/minor bumps applied (electron 42.1.0, vite 8.0.13, eslint 10.4.0, typescript-eslint 8.59.4, electron-log 5.4.4, vitest+coverage 4.1.6, @vitejs/plugin-react 6.0.2, lucide-react 1.16.0, @types/node 25.9.0).
- electron-vite 6.0.0-beta.1 → 5.0.0 stable; electron.vite.config.ts [unchanged | migrated: <detail>]; build + package:dir verified.
- Gates: typecheck ✅ · lint ✅ 0 errors · tests ✅ 129/11 · build ✅.
```
Fill the bracket from Task 3 Step 3 outcome.

- [ ] **Step 4: Commit** (docs only)
```bash
git add docs/superpowers/specs/2026-05-19-vmux-360-quality-roadmap-design.md
git commit -m "docs(spec): mark Phase 2 (deps stable-latest) complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes
- Branch: `chore/phase2-deps` (off `main`, already created).
- Never use `--force`/`--legacy-peer-deps`; never silence new tooling errors with `any`/`@ts-ignore`/`eslint-disable`/rule-downgrades.
- Behavior must not change. Dependency bumps that change runtime behavior (unlikely at patch/minor) must be caught by the test suite — if tests fail, investigate the dep, don't mask.
