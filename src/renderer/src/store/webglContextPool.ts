// Bounded WebGL renderer pool — perf phase 4.
//
// Problem: each TerminalPane wants a @xterm/addon-webgl which holds a WebGL
// context. Chromium's per-document hard cap is ~16 contexts; beyond that,
// contexts are lost in cascade and xterm flips to its slower DOM renderer,
// often with visible flicker. With 5–12 panes across multiple sessions, the
// app routinely sat at the cliff.
//
// Fix: bound the count of WebGL contexts to `size` (default 6 — see settings)
// and LRU-evict when over budget. Panes without a slot mount with the default
// DOM renderer (no addon attached); they can `requestUpgrade` for a one-shot
// callback when a slot frees.
//
// Testability: the pool does NOT import @xterm/addon-webgl. Production code
// passes a factory that builds the real WebglAddon; tests pass a stub. This
// keeps the pool unit-testable in happy-dom/node where WebGL doesn't exist.
//
// Context-loss isolation: on a real WebGL context loss, the production
// factory's onContextLoss handler should call `release({ cooldown: true })`.
// The pool refuses to re-acquire that paneId for ~5 s — prevents a tight
// loop where a perpetually-failing pane keeps stealing slots.

import type { Terminal, ITerminalAddon } from '@xterm/xterm';

export interface WebglSlotHandle {
  readonly addon: ITerminalAddon;
  /** Free the slot. `cooldown:true` blocks re-acquire for this paneId for
   *  ~5 s — used by the production context-loss handler. Idempotent. */
  release(opts?: { cooldown?: boolean }): void;
}

export type WebglAddonFactory = (term: Terminal) => ITerminalAddon;

export interface WebglContextPool {
  /** Get a slot for `paneId`. Returns null when full (caller falls back to
   *  the DOM renderer + optionally calls `requestUpgrade`). Re-acquire for
   *  the same paneId returns the existing handle (idempotent). */
  acquire(
    paneId: string,
    term: Terminal,
    factory: WebglAddonFactory
  ): WebglSlotHandle | null;
  /** Free the slot for `paneId`. Idempotent. */
  release(paneId: string): void;
  /** Register a one-shot waiter that fires when any slot frees AND this
   *  paneId is not on cooldown. Returns an unregister. */
  requestUpgrade(paneId: string, onSlot: () => void): () => void;
  /** Refresh LRU recency without re-acquiring (no-op if not held). */
  touch(paneId: string): void;
  /** Resize the pool. Shrink evicts LRU occupants and notifies the next
   *  waiter for each freed slot. */
  setSize(size: number): void;
  size(): number;
  _stats(): { size: number; occupants: string[]; waiters: string[] };
}

interface Occupant {
  paneId: string;
  handle: WebglSlotHandle;
  lastTouch: number;
}

interface Waiter {
  paneId: string;
  cb: () => void;
}

const COOLDOWN_MS = 5_000;

export function createWebglContextPool(initialSize: number): WebglContextPool {
  let capacity = initialSize;
  const occupants: Occupant[] = [];
  const waiters: Waiter[] = [];
  const cooldowns = new Map<string, number>(); // paneId → unix ms epoch when cooldown ends
  // Monotonic counter for LRU — `Date.now()` ties when multiple acquires/
  // touches happen in the same millisecond (common in tests and real-world
  // rapid session switching). A counter guarantees deterministic ordering.
  let tickCounter = 0;
  const nextTick = (): number => ++tickCounter;

  function isOnCooldown(paneId: string): boolean {
    const until = cooldowns.get(paneId);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      cooldowns.delete(paneId);
      return false;
    }
    return true;
  }

  function findOccupant(paneId: string): Occupant | undefined {
    return occupants.find((o) => o.paneId === paneId);
  }

  function dispatchOneWaiter(): void {
    // FIFO with cooldown filter — first eligible waiter wins.
    for (let i = 0; i < waiters.length; i++) {
      if (isOnCooldown(waiters[i].paneId)) continue;
      const w = waiters.splice(i, 1)[0];
      try {
        w.cb();
      } catch (err) {
        // Renderer console catches it; we explicitly don't strand others.
        // eslint-disable-next-line no-console
        console.error('[webgl-pool] waiter cb threw', err);
      }
      return;
    }
  }

  function evictLRU(): void {
    if (occupants.length === 0) return;
    // Lowest lastTouch wins eviction.
    let victim = 0;
    for (let i = 1; i < occupants.length; i++) {
      if (occupants[i].lastTouch < occupants[victim].lastTouch) victim = i;
    }
    const [evicted] = occupants.splice(victim, 1);
    evicted.handle.release(); // delegate to the handle's own teardown
  }

  return {
    acquire(paneId, term, factory): WebglSlotHandle | null {
      // Idempotent: same paneId re-acquire returns the existing handle.
      const existing = findOccupant(paneId);
      if (existing) {
        existing.lastTouch = nextTick();
        return existing.handle;
      }
      if (isOnCooldown(paneId)) return null;
      if (occupants.length >= capacity) return null;
      // Build the addon FIRST — if the factory throws (e.g. real GL refused
      // to create a context), we leave the pool state unchanged.
      let addon: ITerminalAddon;
      try {
        addon = factory(term);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[webgl-pool] factory threw — caller falls back to DOM', err);
        return null;
      }
      let released = false;
      const handle: WebglSlotHandle = {
        addon,
        release(opts?: { cooldown?: boolean }): void {
          if (released) return;
          released = true;
          const idx = occupants.findIndex((o) => o.paneId === paneId);
          if (idx >= 0) occupants.splice(idx, 1);
          if (opts?.cooldown) {
            cooldowns.set(paneId, Date.now() + COOLDOWN_MS);
          }
          try {
            addon.dispose();
          } catch {
            /* addon was already torn down by xterm */
          }
          dispatchOneWaiter();
        }
      };
      occupants.push({ paneId, handle, lastTouch: nextTick() });
      return handle;
    },

    release(paneId): void {
      const o = findOccupant(paneId);
      o?.handle.release();
    },

    requestUpgrade(paneId, cb): () => void {
      const w: Waiter = { paneId, cb };
      waiters.push(w);
      return () => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
      };
    },

    touch(paneId): void {
      const o = findOccupant(paneId);
      if (o) o.lastTouch = nextTick();
    },

    setSize(size): void {
      capacity = Math.max(0, size | 0);
      while (occupants.length > capacity) evictLRU();
    },

    size(): number {
      return occupants.length;
    },

    _stats(): { size: number; occupants: string[]; waiters: string[] } {
      return {
        size: occupants.length,
        occupants: occupants.map((o) => o.paneId),
        waiters: waiters.map((w) => w.paneId)
      };
    }
  };
}

/** Production singleton — TerminalPane.tsx imports this. Default size is set
 *  here as a safe floor; the real size is driven from settings.webglPoolSize
 *  via `webglPool.setSize(n)` in a live effect (Task 4.5). */
export const webglPool: WebglContextPool = createWebglContextPool(6);
