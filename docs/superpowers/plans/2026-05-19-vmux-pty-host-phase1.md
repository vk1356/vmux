# vMux PTY Host — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the entire PTY subsystem (node-pty, `PaneDataBuffer`, all ANSI strip / detector / agent-state analysis) out of the Electron `main` thread into a dedicated `utilityProcess` ("PTY Host"), with `main` reduced to a thin async proxy — so 5–12 spewing PTYs never block the UI/IPC thread.

**Architecture:** `PtyManager` moves verbatim into a new `utilityProcess` entry. A typed message protocol bridges `main` ↔ host over the utilityProcess `MessagePort`. A `PtyHostClient` in `main` re-exposes the *same* event/method surface that `ipc.ts` and `index.ts` already consume (drop-in: `export const ptyManager = new PtyHostClient()`), proxying calls and re-emitting host events. Transport to the renderer is **unchanged** in Phase 1 (still `webContents.send` via existing IPC channels) — only the *owner process* of the PTYs changes. Phases 2–5 (zero-copy transport, adaptive flush, WebGL pool, startup) are out of scope here.

**Tech Stack:** Electron `utilityProcess` / `MessageChannelMain`, node-pty (ConPTY on Windows), electron-vite multi-entry build, TypeScript, Vitest.

---

## Architectural notes & spec refinement

- **Spec said** "main garde persistance sessions". **This plan refines that:** `PtyManager` (which owns `loadSessions`/`saveSessions` calls) relocates *whole* into the host, so persistence physically executes in the host process. It is *functionally identical* — same `settings-store` module, same JSON file, same data. This is the lowest-risk seam because **zero lines of `PtyManager` internal logic change**; only its host process and access path change. This refinement was surfaced to the user before planning.
- `ipc.ts` currently calls `ptyManager.list()` **synchronously** in several handlers. Crossing a process boundary makes session reads async. Mitigation: `main` keeps a **synchronously-readable session cache** (`PtyHostClient.list()` returns the last-known snapshot, refreshed on every `sessionUpdate` event the host pushes). Mutating calls (`createSession`, etc.) become `async` (they already return Promises in the current API — verified in `pty-manager.ts`).
- **Hard gate:** Task 1 is a throwaway de-risk spike. If node-pty cannot spawn/echo/resize/kill inside a `utilityProcess` on Windows with the bundled `conpty.dll`, **STOP** and report — the rest of the plan (and Phases 2–5) depends on it.

## File structure

- **Create** `src/shared/pty-host-protocol.ts` — typed request/event message contracts (shared by host + client). One responsibility: the wire contract.
- **Create** `src/main/pty-host/entry.ts` — the `utilityProcess` entry point. Instantiates `PtyManager`, bridges `parentPort` ↔ manager.
- **Create** `src/main/pty-host-client.ts` — `main`-side proxy with the legacy `ptyManager` surface (EventEmitter + methods).
- **Create** `src/main/pty-host-supervisor.ts` — spawns the utilityProcess, handles crash/respawn.
- **Modify** `src/main/pty-manager.ts` — no logic change; add a single exported factory `createPtyManager()` (Task 5) so the host owns instantiation instead of the module-level singleton.
- **Modify** `src/main/ipc.ts` — swap `import { ptyManager } from './pty-manager'` → `from './pty-host-client'`; make the 2 sync `list()` call sites tolerate the cache (no signature change needed).
- **Modify** `src/main/index.ts` — boot the supervisor before `registerIpc`; route `before-quit` shutdown through the client.
- **Modify** `electron.vite.config.ts` — add the host as a second `main` rollup input, keep node-pty external.
- **Modify** `package.json` `build.asarUnpack` — already unpacks node-pty; add the bundled host JS is inside asar (fine) but ensure node-pty resolves from the host (verified in Task 1).
- **Test** `src/main/__tests__/pty-host-protocol.test.ts`, `src/main/__tests__/pty-host-client.test.ts`.

---

### Task 1: De-risk spike — node-pty inside utilityProcess on Windows (THROWAWAY, HARD GATE)

> **Spike outcome (2026-05-19):** PASS. `node-pty@1.1.0` spawned `powershell.exe` inside an Electron 42.1.0 `utilityProcess.fork`, exercised spawn → resize → write → data → kill with bundled ConPTY (`useConptyDll: true`). Observed stdout: `{"kind":"ready","pid":18200}` → `{"kind":"data","bytes":23}` → `{"kind":"exit","exitCode":1}` → `[spike] PASS`, process exit code 0. No ABI rebuild was needed — node-pty loaded cleanly under Electron's Node ABI with no `NODE_MODULE_VERSION` error. Decision gate: **PROCEED** with the plan.

**Files:**
- Create: `scripts/spike-pty-host/host.cjs` (throwaway)
- Create: `scripts/spike-pty-host/run.cjs` (throwaway)

- [ ] **Step 1: Write the spike host**

`scripts/spike-pty-host/host.cjs`:

```js
// Throwaway. Runs inside Electron utilityProcess. Spawns a pty, echoes a
// command, reports first data + exit back to parent.
const pty = require('node-pty');
const isWin = process.platform === 'win32';
const shell = isWin ? 'powershell.exe' : 'bash';
const p = pty.spawn(shell, [], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
  env: process.env, useConptyDll: isWin
});
let bytes = 0;
p.onData((d) => {
  bytes += Buffer.byteLength(d);
  if (bytes > 0) process.parentPort.postMessage({ kind: 'data', bytes });
});
p.onExit(({ exitCode }) => process.parentPort.postMessage({ kind: 'exit', exitCode }));
process.parentPort.on('message', (e) => {
  const m = e.data;
  if (m.kind === 'write') p.write(m.data);
  if (m.kind === 'resize') p.resize(m.cols, m.rows);
  if (m.kind === 'kill') p.kill();
});
process.parentPort.postMessage({ kind: 'ready', pid: p.pid });
```

- [ ] **Step 2: Write the spike runner**

`scripts/spike-pty-host/run.cjs`:

```js
const { app, utilityProcess } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'host.cjs'), [], {
    stdio: 'inherit'
  });
  let gotData = false;
  child.on('message', (m) => {
    console.log('[spike] from host:', JSON.stringify(m));
    if (m.kind === 'ready') {
      child.postMessage({ kind: 'resize', cols: 100, rows: 30 });
      child.postMessage({ kind: 'write', data: 'echo SPIKE_OK\r' });
    }
    if (m.kind === 'data' && !gotData) {
      gotData = true;
      setTimeout(() => child.postMessage({ kind: 'kill' }), 1500);
    }
    if (m.kind === 'exit') {
      console.log(gotData ? '[spike] PASS' : '[spike] FAIL: no data');
      app.exit(gotData ? 0 : 1);
    }
  });
});
```

- [ ] **Step 3: Run the spike on Windows**

Run: `npx electron scripts/spike-pty-host/run.cjs`
Expected: stdout shows `{"kind":"ready",...}`, then `{"kind":"data",...}`, then `{"kind":"exit",...}`, then `[spike] PASS`, exit code 0.

- [ ] **Step 4: Decision gate**

If PASS: proceed. If FAIL (native module not found, ConPTY error, no data): **STOP. Do not continue the plan.** Report the exact error — likely fixes to investigate before resuming: (a) node-pty needs `asarUnpack` resolution from the forked process; pass an absolute path to the unpacked `node-pty` via a custom `require`; (b) try `useConptyDll: false`; (c) fall back to `child_process.fork` with a Node binary. Document the outcome in the plan file under this task.

- [ ] **Step 5: Delete the spike, commit the decision**

```bash
git rm -r scripts/spike-pty-host
git commit -m "chore(pty-host): de-risk spike validated — node-pty runs in utilityProcess"
```

---

### Task 2: Wire protocol contract

**Files:**
- Create: `src/shared/pty-host-protocol.ts`
- Test: `src/main/__tests__/pty-host-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/__tests__/pty-host-protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isHostEvent, isHostRequest } from '@shared/pty-host-protocol';

describe('pty-host-protocol guards', () => {
  it('accepts a well-formed event', () => {
    expect(isHostEvent({ kind: 'paneData', paneId: 'p1', data: new Uint8Array(1) })).toBe(true);
  });
  it('rejects a non-event', () => {
    expect(isHostEvent({ kind: 'nope' })).toBe(false);
    expect(isHostEvent(null)).toBe(false);
  });
  it('accepts a well-formed request', () => {
    expect(isHostRequest({ id: 1, method: 'writePane', args: ['p1', 'x'] })).toBe(true);
  });
  it('rejects a non-request', () => {
    expect(isHostRequest({ id: 1 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/pty-host-protocol.test.ts`
Expected: FAIL — cannot resolve `@shared/pty-host-protocol`.

- [ ] **Step 3: Write the protocol module**

`src/shared/pty-host-protocol.ts`:

```ts
// Wire contract between main (PtyHostClient) and the PTY Host utilityProcess.
// Requests: main → host (RPC). Events: host → main (push, mirror PtyManager
// EventEmitter). Kept dependency-free so it bundles into both entries.
import type {
  AgentRunState, DetectedEvent, PaneId, Session, TerminalPane, PaneAttentionLevel
} from './types';

/** RPC: every async/void PtyManager method the client proxies. `id` correlates
 *  the reply; void methods reply with `result: undefined`. */
export interface HostRequest {
  readonly id: number;
  readonly method:
    | 'list' | 'createSession' | 'removeSession' | 'splitPane' | 'closePane'
    | 'focusPane' | 'relayout' | 'resizeSplit' | 'removeUrlFromPane'
    | 'renamePane' | 'togglePin' | 'setSessionColor' | 'renameSession'
    | 'restartAll' | 'setPaneUrl' | 'restartPane' | 'writePane'
    | 'resizePane' | 'autoRestoreSessions' | 'sessionForPane' | 'shutdown';
  readonly args: readonly unknown[];
}

export interface HostReply {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

/** Push events — names + payload tuples mirror PtyManager's `Events` type
 *  exactly so the client can re-`emit` them unchanged. */
export type HostEvent =
  | { kind: 'paneData'; paneId: PaneId; data: Uint8Array }
  | { kind: 'paneStatus'; sessionId: string; paneId: PaneId; pane: TerminalPane }
  | { kind: 'sessionUpdate'; session: Session }
  | { kind: 'urlsDetected'; paneId: PaneId; urls: string[] }
  | { kind: 'eventDetected'; event: DetectedEvent }
  | { kind: 'paneAttention'; paneId: PaneId; level: PaneAttentionLevel }
  | { kind: 'paneAgentState'; paneId: PaneId; state: AgentRunState };

const EVENT_KINDS = new Set<HostEvent['kind']>([
  'paneData', 'paneStatus', 'sessionUpdate', 'urlsDetected',
  'eventDetected', 'paneAttention', 'paneAgentState'
]);

export function isHostEvent(v: unknown): v is HostEvent {
  return (
    typeof v === 'object' && v !== null && 'kind' in v &&
    EVENT_KINDS.has((v as { kind: HostEvent['kind'] }).kind)
  );
}

export function isHostRequest(v: unknown): v is HostRequest {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as HostRequest).id === 'number' &&
    typeof (v as HostRequest).method === 'string' &&
    Array.isArray((v as HostRequest).args)
  );
}

export function isHostReply(v: unknown): v is HostReply {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as HostReply).id === 'number'
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/pty-host-protocol.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify PaneAttentionLevel export exists**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors. If `PaneAttentionLevel` is not exported from `@shared/types`, replace its usage in the protocol with the inline union `'activity' | 'alert' | 'needs-input'` (matches `PtyManager.Events.paneAttention`).

- [ ] **Step 6: Commit**

```bash
git add src/shared/pty-host-protocol.ts src/main/__tests__/pty-host-protocol.test.ts
git commit -m "feat(pty-host): wire protocol contract + guards"
```

---

### Task 3: PtyManager factory (decouple from module singleton)

**Files:**
- Modify: `src/main/pty-manager.ts:1122` (the `export const ptyManager = new PtyManager()` line)

- [ ] **Step 1: Add a factory export without changing class logic**

In `src/main/pty-manager.ts`, change the final line:

```ts
export const ptyManager = new PtyManager();
```

to:

```ts
/** Factory — used by the PTY Host entry to own the single instance in the
 *  host process. The module-level `ptyManager` singleton is retained ONLY for
 *  existing unit tests that import it directly; production main no longer
 *  imports this module (it uses PtyHostClient). */
export function createPtyManager(): PtyManager {
  return new PtyManager();
}

export const ptyManager = new PtyManager();
```

Also add `export` to the class declaration (`class PtyManager` → `export class PtyManager`) so the host can type against it.

- [ ] **Step 2: Verify nothing broke**

Run: `npx vitest run` then `npx tsc --noEmit -p tsconfig.node.json`
Expected: all existing tests PASS, no type errors. (No behavior changed — only added exports.)

- [ ] **Step 3: Commit**

```bash
git add src/main/pty-manager.ts
git commit -m "refactor(pty-manager): export class + createPtyManager factory"
```

---

### Task 4: PTY Host entry point

**Files:**
- Create: `src/main/pty-host/entry.ts`

- [ ] **Step 1: Write the host entry**

`src/main/pty-host/entry.ts`:

```ts
// Runs inside an Electron utilityProcess. Owns the single PtyManager instance
// (node-pty + PaneDataBuffer + all analysis). Bridges parentPort <-> manager:
//   inbound  HostRequest  -> manager method call -> HostReply
//   manager EventEmitter  -> HostEvent           -> parentPort
// No logic lives here beyond the bridge — PtyManager is unchanged.
import { createPtyManager } from '../pty-manager';
import { isHostRequest, type HostEvent, type HostReply } from '@shared/pty-host-protocol';

const mgr = createPtyManager();
const port = process.parentPort;

function post(msg: HostEvent | HostReply): void {
  port.postMessage(msg);
}

// Mirror every PtyManager event onto the wire. Names/payloads match the
// protocol union 1:1.
mgr.on('paneData', (paneId, data) => post({ kind: 'paneData', paneId, data }));
mgr.on('paneStatus', (sessionId, paneId, pane) =>
  post({ kind: 'paneStatus', sessionId, paneId, pane }));
mgr.on('sessionUpdate', (session) => post({ kind: 'sessionUpdate', session }));
mgr.on('urlsDetected', (paneId, urls) => post({ kind: 'urlsDetected', paneId, urls }));
mgr.on('eventDetected', (event) => post({ kind: 'eventDetected', event }));
mgr.on('paneAttention', (paneId, level) =>
  post({ kind: 'paneAttention', paneId, level }));
mgr.on('paneAgentState', (paneId, state) =>
  post({ kind: 'paneAgentState', paneId, state }));

port.on('message', (e) => {
  const req = e.data;
  if (!isHostRequest(req)) return;
  void (async () => {
    try {
      // Every proxied method exists on PtyManager with these names (verified
      // against pty-manager.ts). `as never` because method dispatch is dynamic.
      const fn = (mgr as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method];
      if (typeof fn !== 'function') {
        post({ id: req.id, error: `unknown method ${req.method}` });
        return;
      }
      const result = await fn.apply(mgr, req.args as unknown[]);
      post({ id: req.id, result });
    } catch (err) {
      post({ id: req.id, error: (err as Error).message });
    }
  })();
});

// Signal readiness so the supervisor can flush any queued requests.
post({ kind: 'sessionUpdate', session: undefined as never } as never);
```

- [ ] **Step 2: Replace the fake ready-ping with a real one**

The last line above is a placeholder hack. Replace it with an explicit ready reply using a reserved id `0`:

```ts
// Reserved id 0 = "host ready" handshake (never used by real requests, which
// start at 1 in PtyHostClient).
post({ id: 0, result: 'ready' });
```

Remove the `post({ kind: 'sessionUpdate', ... } as never)` line entirely.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/pty-host/entry.ts
git commit -m "feat(pty-host): utilityProcess entry bridging PtyManager <-> parentPort"
```

---

### Task 5: electron-vite build — second main entry

**Files:**
- Modify: `electron.vite.config.ts:11-26` (the `main` block)

- [ ] **Step 1: Add the host as a second rollup input**

Replace the `main` block in `electron.vite.config.ts` with:

```ts
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // Two entries: the app main, and the PTY Host utilityProcess.
        input: {
          index: resolve('src/main/index.ts'),
          'pty-host': resolve('src/main/pty-host/entry.ts')
        },
        // node-pty / pidusage have native .node — keep externalized so the
        // host resolves the unpacked copy at runtime (asarUnpack handles it).
        external: ['node-pty', 'pidusage'],
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
```

- [ ] **Step 2: Build and verify both entries emit**

Run: `npm run build`
Expected: `out/main/index.js` AND `out/main/pty-host.js` both exist.

Run: `ls out/main/`
Expected: listing includes `index.js` and `pty-host.js`.

- [ ] **Step 3: Commit**

```bash
git add electron.vite.config.ts
git commit -m "build: emit pty-host utilityProcess as second main entry"
```

---

### Task 6: PTY Host supervisor

**Files:**
- Create: `src/main/pty-host-supervisor.ts`

- [ ] **Step 1: Write the supervisor**

`src/main/pty-host-supervisor.ts`:

```ts
// Owns the utilityProcess lifecycle: fork, ready handshake, crash respawn.
// Exposes a stable MessagePort-like surface (send + onMessage) so
// PtyHostClient does not care about respawns.
import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import log from 'electron-log/main';
import { isHostReply } from '@shared/pty-host-protocol';

type IncomingHandler = (msg: unknown) => void;

export class PtyHostSupervisor {
  private child: UtilityProcess | null = null;
  private onMessageCb: IncomingHandler | null = null;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private respawning = false;

  /** Absolute path to the bundled host entry (electron-vite emits it next to
   *  index.js — __dirname is out/main at runtime). */
  private hostPath(): string {
    return path.join(__dirname, 'pty-host.js');
  }

  start(): Promise<void> {
    this.readyPromise = new Promise((res) => (this.readyResolve = res));
    this.fork();
    return this.readyPromise;
  }

  private fork(): void {
    const child = utilityProcess.fork(this.hostPath(), [], {
      serviceName: 'vmux-pty-host',
      stdio: 'inherit'
    });
    this.child = child;
    child.on('message', (msg: unknown) => {
      // Ready handshake: reserved reply id 0.
      if (isHostReply(msg) && msg.id === 0 && msg.result === 'ready') {
        this.readyResolve?.();
        this.readyResolve = null;
        return;
      }
      this.onMessageCb?.(msg);
    });
    child.on('exit', (code) => {
      log.error(`[pty-host] exited code=${code}`);
      if (!this.respawning) this.respawn();
    });
  }

  private respawn(): void {
    this.respawning = true;
    log.warn('[pty-host] respawning');
    this.readyPromise = new Promise((res) => (this.readyResolve = res));
    this.fork();
    void this.readyPromise.then(() => {
      this.respawning = false;
      log.info('[pty-host] respawned');
    });
  }

  send(msg: unknown): void {
    this.child?.postMessage(msg);
  }

  onMessage(cb: IncomingHandler): void {
    this.onMessageCb = cb;
  }

  async stop(): Promise<void> {
    this.respawning = true; // suppress respawn-on-exit during shutdown
    this.child?.kill();
    this.child = null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors. If `UtilityProcess` is not exported as a type from `electron`, use `ReturnType<typeof utilityProcess.fork>` instead.

- [ ] **Step 3: Commit**

```bash
git add src/main/pty-host-supervisor.ts
git commit -m "feat(pty-host): supervisor with ready handshake + crash respawn"
```

---

### Task 7: PtyHostClient — main-side proxy

**Files:**
- Create: `src/main/pty-host-client.ts`
- Test: `src/main/__tests__/pty-host-client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/__tests__/pty-host-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PtyHostClient } from '../pty-host-client';

// Fake supervisor: captures sent requests, lets the test push events/replies.
function makeFakeSupervisor() {
  let onMsg: ((m: unknown) => void) | null = null;
  const sent: unknown[] = [];
  return {
    sup: {
      start: vi.fn().mockResolvedValue(undefined),
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (m: unknown) => void) => { onMsg = cb; },
      stop: vi.fn().mockResolvedValue(undefined)
    },
    sent,
    push: (m: unknown) => onMsg?.(m)
  };
}

describe('PtyHostClient', () => {
  it('re-emits paneData host events through its EventEmitter surface', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const seen: Array<[string, Uint8Array]> = [];
    client.on('paneData', (paneId, data) => seen.push([paneId, data]));
    push({ kind: 'paneData', paneId: 'p1', data: new Uint8Array([65]) });
    expect(seen).toEqual([['p1', new Uint8Array([65])]]);
  });

  it('proxies a method call as a HostRequest and resolves on reply', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const p = client.removeSession('s1');
    expect(sent[0]).toMatchObject({ method: 'removeSession', args: ['s1'] });
    const reqId = (sent[0] as { id: number }).id;
    push({ id: reqId, result: undefined });
    await expect(p).resolves.toBeUndefined();
  });

  it('list() returns the cached snapshot synchronously, updated on sessionUpdate', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    expect(client.list()).toEqual([]);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: {}, tree: { kind: 'leaf', paneId: 'p' }, cwd: '/', createdAt: 0, activePaneId: 'p' } });
    expect(client.list().map((s) => s.id)).toEqual(['s1']);
  });

  it('sessionForPane resolves from the cached snapshot synchronously', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: { p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 } }, tree: { kind: 'leaf', paneId: 'p1' }, cwd: '/', createdAt: 0, activePaneId: 'p1' } });
    expect(client.sessionForPane('p1')).toBe('s1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/pty-host-client.test.ts`
Expected: FAIL — cannot resolve `../pty-host-client`.

- [ ] **Step 3: Write the client**

`src/main/pty-host-client.ts`:

```ts
// main-side drop-in replacement for the `ptyManager` singleton. Same surface
// ipc.ts/index.ts consume: an EventEmitter (.on('paneData', ...) etc.) plus
// the proxied methods. RPC over PtyHostSupervisor. A synchronously-readable
// session snapshot is maintained from `sessionUpdate` events so the two
// existing sync call sites (list, sessionForPane) keep working without
// signature churn.
import { EventEmitter } from 'node:events';
import log from 'electron-log/main';
import type { PtyHostSupervisor } from './pty-host-supervisor';
import {
  isHostEvent, isHostReply, type HostEvent, type HostRequest
} from '@shared/pty-host-protocol';
import type { Session, PaneId } from '@shared/types';

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

export class PtyHostClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private snapshot: Session[] = [];
  private paneIndex = new Map<PaneId, string>();

  constructor(private sup: PtyHostSupervisor) {
    super();
    this.sup.onMessage((msg) => this.handle(msg));
  }

  /** Boot the host process; resolves once it has handshaked ready. */
  init(): Promise<void> {
    return this.sup.start();
  }

  private handle(msg: unknown): void {
    if (isHostReply(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (isHostEvent(msg)) {
      if (msg.kind === 'sessionUpdate') this.cacheSession(msg.session);
      this.dispatch(msg);
    }
  }

  /** Refresh the synchronously-readable snapshot + reverse pane index. */
  private cacheSession(session: Session): void {
    const i = this.snapshot.findIndex((s) => s.id === session.id);
    if (i >= 0) this.snapshot[i] = session;
    else this.snapshot.push(session);
    this.paneIndex.clear();
    for (const s of this.snapshot)
      for (const pid of Object.keys(s.panes)) this.paneIndex.set(pid, s.id);
  }

  /** Translate a HostEvent into the legacy EventEmitter signature so ipc.ts's
   *  `ptyManager.on('paneData', (paneId, data) => ...)` works unchanged. */
  private dispatch(e: HostEvent): void {
    switch (e.kind) {
      case 'paneData': this.emit('paneData', e.paneId, e.data); break;
      case 'paneStatus': this.emit('paneStatus', e.sessionId, e.paneId, e.pane); break;
      case 'sessionUpdate':
        this.snapshot = this.snapshot.filter((s) => s.id !== e.session.id || true);
        this.emit('sessionUpdate', e.session); break;
      case 'urlsDetected': this.emit('urlsDetected', e.paneId, e.urls); break;
      case 'eventDetected': this.emit('eventDetected', e.event); break;
      case 'paneAttention': this.emit('paneAttention', e.paneId, e.level); break;
      case 'paneAgentState': this.emit('paneAgentState', e.paneId, e.state); break;
    }
  }

  private call<T>(method: HostRequest['method'], args: readonly unknown[]): Promise<T> {
    const id = this.nextId++;
    const req: HostRequest = { id, method, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.sup.send(req);
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  // ---- Synchronous reads served from the snapshot ----
  list(): Session[] { return this.snapshot; }
  sessionForPane(paneId: PaneId): string | undefined { return this.paneIndex.get(paneId); }

  // ---- Fire-and-forget (no reply awaited; matches current void methods) ----
  writePane(paneId: string, data: string): void {
    void this.call('writePane', [paneId, data]).catch((e) =>
      log.debug('[pty-host-client] writePane', e));
  }
  resizePane(paneId: string, size: unknown): void {
    void this.call('resizePane', [paneId, size]).catch((e) =>
      log.debug('[pty-host-client] resizePane', e));
  }
  focusPane(sessionId: string, paneId: string): void {
    void this.call('focusPane', [sessionId, paneId]);
  }
  resizeSplit(sessionId: string, splitPath: unknown, sizes: number[]): void {
    void this.call('resizeSplit', [sessionId, splitPath, sizes]);
  }
  setPaneUrl(sessionId: string, paneId: string, url: string): void {
    void this.call('setPaneUrl', [sessionId, paneId, url]);
  }

  // ---- Async (already Promise-returning in the current API) ----
  createSession(input: unknown) { return this.call('createSession', [input]); }
  removeSession(id: string) { return this.call<void>('removeSession', [id]); }
  splitPane(input: unknown) { return this.call('splitPane', [input]); }
  closePane(s: string, p: string) { return this.call('closePane', [s, p]); }
  relayout(s: string, preset: unknown) { return this.call('relayout', [s, preset]); }
  removeUrlFromPane(s: string, p: string, u: string) { return this.call('removeUrlFromPane', [s, p, u]); }
  renamePane(s: string, p: string, l: string) { return this.call('renamePane', [s, p, l]); }
  togglePin(s: string) { return this.call('togglePin', [s]); }
  setSessionColor(s: string, c: string | null) { return this.call('setSessionColor', [s, c]); }
  renameSession(s: string, n: string) { return this.call('renameSession', [s, n]); }
  restartAll(s: string) { return this.call('restartAll', [s]); }
  restartPane(s: string, p: string) { return this.call('restartPane', [s, p]); }
  autoRestoreSessions() { return this.call<number>('autoRestoreSessions', []); }
  shutdown() { return this.call<void>('shutdown', []); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/pty-host-client.test.ts`
Expected: PASS (4 tests). If the `Session` literal in the test mismatches `@shared/types` (missing required fields), read `src/shared/types.ts` for the `Session` shape and adjust the test literals — keep `id`/`panes`/`tree` which the assertions use.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-host-client.ts src/main/__tests__/pty-host-client.test.ts
git commit -m "feat(pty-host): main-side proxy client with sync session snapshot"
```

---

### Task 8: Bootstrap wiring — boot host, swap import, route shutdown

**Files:**
- Modify: `src/main/ipc.ts` (the single `import { ptyManager } from './pty-manager'` line)
- Modify: `src/main/index.ts:4-5,243-301,337-349`

- [ ] **Step 1: Swap the ipc.ts import**

In `src/main/ipc.ts`, change:

```ts
import { ptyManager } from './pty-manager';
```

to:

```ts
import { ptyManager } from './pty-host-client-singleton';
```

- [ ] **Step 2: Create the singleton accessor**

`src/main/pty-host-client-singleton.ts`:

```ts
// Single PtyHostClient instance + its supervisor, created at boot by
// index.ts (via initPtyHost) and consumed everywhere ipc.ts used the old
// `ptyManager` singleton. Split out so importing the client surface does not
// fork the utilityProcess as a module side effect (testability + boot order).
import { PtyHostSupervisor } from './pty-host-supervisor';
import { PtyHostClient } from './pty-host-client';

let instance: PtyHostClient | null = null;

export function initPtyHost(): Promise<void> {
  if (instance) return Promise.resolve();
  instance = new PtyHostClient(new PtyHostSupervisor());
  return instance.init();
}

/** Proxy object so `import { ptyManager }` keeps a stable reference even
 *  though the real client is created asynchronously at boot. Methods/events
 *  are forwarded; throws if used before initPtyHost(). */
export const ptyManager: PtyHostClient = new Proxy({} as PtyHostClient, {
  get(_t, prop) {
    if (!instance) throw new Error('PTY host not initialized');
    const v = (instance as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === 'function' ? v.bind(instance) : v;
  }
});
```

- [ ] **Step 3: Boot the host in index.ts before registerIpc**

In `src/main/index.ts`, inside `app.whenReady().then(async () => {` (line ~243), **before** `registerIpc(() => mainWindow)` (line ~259), add:

```ts
  const { initPtyHost } = await import('./pty-host-client-singleton');
  await initPtyHost();
```

Remove the old `import { ptyManager } from './pty-manager'` at line 5 and replace with:

```ts
import { ptyManager } from './pty-host-client-singleton';
```

- [ ] **Step 4: Route before-quit shutdown through the client**

The `before-quit` handler at line ~337 already calls `ptyManager.shutdown()`. With the import swapped it now proxies to the host. After `.shutdown()` resolves, also stop the supervisor. Change the `.then(...)` chain (line ~344-349) to additionally:

```ts
    .then(async () => {
      const { stopPtyHost } = await import('./pty-host-client-singleton');
      await stopPtyHost();
      app.exit(0);
    })
```

And add to `pty-host-client-singleton.ts`:

```ts
export async function stopPtyHost(): Promise<void> {
  // instance.shutdown() already ran via before-quit; just tear down the proc.
  await (instance as unknown as { sup?: { stop(): Promise<void> } })?.sup?.stop?.();
}
```

(If `sup` is private and inaccessible, expose `async stop()` on `PtyHostClient` that calls `this.sup.stop()` and call that instead.)

- [ ] **Step 5: Typecheck + full test suite**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx vitest run`
Expected: no type errors; all tests PASS (existing `pty-manager` direct-import tests still pass — that module is untouched and its singleton still exists).

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/main/pty-host-client-singleton.ts
git commit -m "feat(pty-host): boot host at startup, swap ptyManager to proxy client"
```

---

### Task 9: End-to-end smoke + latency/throughput bench

**Files:**
- Create: `scripts/bench-pty-host.md` (manual bench checklist + numbers log)

- [ ] **Step 1: Manual smoke — packaged build**

Run: `npm run build && npx electron .`
Expected: app launches; create a session; the terminal spawns, echoes keystrokes, resizes with the window, agent boots. Open 6 panes; run a spew command (e.g. `for ($i=0;$i-lt100000;$i++){echo $i}`) in 3 of them simultaneously.
Expected: UI stays responsive; typing in a 4th pane stays low-latency during the spew (this is the whole point — main thread no longer blocked).

- [ ] **Step 2: Record before/after numbers**

`scripts/bench-pty-host.md`:

```md
# PTY Host Phase 1 — bench log

## Method
- 6 panes, 3 running `for ($i=0;$i-lt200000;$i++){echo $i}` (pwsh).
- Measure: keystroke→echo latency in a quiet 4th pane during spew (eyeball /
  screen capture frame count), and main-process CPU% (Task Manager).

## Baseline (pre-Phase-1, commit cd85268)
- Echo latency under spew: <fill>
- main CPU under spew: <fill>

## Phase 1 (post-Task-8)
- Echo latency under spew: <fill>
- main CPU under spew: <fill>  (expect: dropped — work moved to host proc)
- pty-host CPU under spew: <fill>
```

Fill the `<fill>` cells by running both commits. Phase 1 success criterion: **main-process CPU under spew drops substantially** (analysis moved off it) and echo latency in the quiet pane no longer degrades under spew. (Renderer-side latency wins are Phases 2–3 — not expected here.)

- [ ] **Step 3: Commit the bench log**

```bash
git add scripts/bench-pty-host.md
git commit -m "test(pty-host): phase-1 e2e smoke + bench log"
```

---

### Task 10: Release Phase 1

- [ ] **Step 1: Bump version**

Edit `package.json` `"version": "0.8.0"` → `"0.9.0"` (minor: architectural feature, backward-compatible UX).

- [ ] **Step 2: Full gate**

Run: `npm run lint && npm run test && npm run build`
Expected: lint clean, all tests pass (coverage thresholds hold — new modules are tested), build emits `index.js` + `pty-host.js`.

- [ ] **Step 3: Commit + release**

```bash
git add package.json
git commit -m "v0.9.0: PTY Host — node-pty + analysis moved off main thread (perf phase 1)"
git push
npm run release
```

(Follows the project release workflow: commit → push → bump → release.)

---

## Self-review

**Spec coverage (Phase 1 scope only):**
- "PTY Host utilityProcess unique" → Tasks 4, 5, 6. ✓
- "Relocalisation node-pty / PaneDataBuffer / pipeline analyse" → Task 3+4 (whole PtyManager relocated; logic unchanged). ✓
- "Transport encore via main (IPC inchangé)" → Task 7/8 keep existing IPC channels; client re-emits, ipc.ts forwarding unchanged. ✓
- "Superviseur + respawn" → Task 6. ✓
- "Hard gate ConPTY in utilityProcess Windows" → Task 1. ✓
- "Tests d'intégration host + bench" → Tasks 7, 9. ✓
- Phases 2–5 (zero-copy, adaptive flush, WebGL pool, startup) → explicitly out of scope; flagged at top.

**Placeholder scan:** Task 9 bench log has intentional `<fill>` cells — these are runtime measurements the executor records, not plan placeholders (the method to obtain them is fully specified). No code-step placeholders.

**Type consistency:** `HostRequest.method` union (Task 2) matches every method proxied in `PtyHostClient` (Task 7) and dispatched in `entry.ts` (Task 4). `HostEvent` kinds match `dispatch()` cases and the `entry.ts` `mgr.on(...)` mirrors 1:1. `createPtyManager` (Task 3) is the only new `pty-manager.ts` export consumed by `entry.ts` (Task 4). `initPtyHost`/`stopPtyHost`/`ptyManager` proxy (Task 8) consistent across ipc.ts and index.ts.

**Known follow-ups (Phase 2+ , not gaps):** `paneData` still crosses two structured-clone hops (host→main→renderer) in Phase 1 — eliminated in Phase 2 via direct MessageChannelMain. `list()` snapshot is eventually-consistent (refreshed on `sessionUpdate`); acceptable because the host emits `sessionUpdate` on every mutation today (verified in pty-manager.ts).
