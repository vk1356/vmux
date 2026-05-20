import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebglContextPool } from '../webglContextPool';

// Fake xterm Terminal — pool never inspects fields, only passes to factory.
const fakeTerm = (): unknown => ({});

// Factory that returns a fake addon (the production factory builds a real
// WebglAddon; we inject a stub here since happy-dom/jsdom lack WebGL).
function makeFakeFactory() {
  let count = 0;
  return vi.fn(() => ({
    _id: ++count,
    activate: vi.fn(),
    dispose: vi.fn()
  }));
}

describe('createWebglContextPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires up to `size` slots; the (size+1)th returns null', () => {
    const pool = createWebglContextPool(2);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    const b = pool.acquire('p2', fakeTerm() as never, f);
    expect(a?.addon).toBeTruthy();
    expect(b?.addon).toBeTruthy();
    expect(pool.size()).toBe(2);
    const c = pool.acquire('p3', fakeTerm() as never, f);
    expect(c).toBeNull();
    expect(pool.size()).toBe(2);
  });

  it('release() frees a slot and lets a new pane acquire', () => {
    const pool = createWebglContextPool(1);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    expect(pool.acquire('p2', fakeTerm() as never, f)).toBeNull();
    a?.release();
    const b = pool.acquire('p2', fakeTerm() as never, f);
    expect(b?.addon).toBeTruthy();
  });

  it('release() is idempotent', () => {
    const pool = createWebglContextPool(1);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    a?.release();
    expect(() => a?.release()).not.toThrow();
    expect(pool.size()).toBe(0);
  });

  it('re-acquire for the same paneId is idempotent (returns existing slot)', () => {
    const pool = createWebglContextPool(2);
    const f = makeFakeFactory();
    const first = pool.acquire('p1', fakeTerm() as never, f);
    const second = pool.acquire('p1', fakeTerm() as never, f);
    expect(second?.addon).toBe(first?.addon);
    expect(pool.size()).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('requestUpgrade fires the callback when a slot frees', () => {
    const pool = createWebglContextPool(1);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    expect(pool.acquire('p2', fakeTerm() as never, f)).toBeNull();
    const cb = vi.fn();
    pool.requestUpgrade('p2', cb);
    expect(cb).not.toHaveBeenCalled();
    a?.release();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('requestUpgrade fires once per registration, not on later releases', () => {
    const pool = createWebglContextPool(1);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    const cb = vi.fn();
    pool.requestUpgrade('p2', cb);
    a?.release();
    expect(cb).toHaveBeenCalledTimes(1);
    // Re-take and release — the previous (one-shot) waiter must not re-fire.
    const a2 = pool.acquire('p1', fakeTerm() as never, f);
    a2?.release();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('requestUpgrade returns an unregister that cancels the waiter', () => {
    const pool = createWebglContextPool(1);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    const cb = vi.fn();
    const off = pool.requestUpgrade('p2', cb);
    off();
    a?.release();
    expect(cb).not.toHaveBeenCalled();
  });

  it('setSize shrink evicts the LRU-touched occupants and notifies waiters', () => {
    const pool = createWebglContextPool(3);
    const f = makeFakeFactory();
    pool.acquire('a', fakeTerm() as never, f);
    pool.acquire('b', fakeTerm() as never, f);
    pool.acquire('c', fakeTerm() as never, f);
    // Touch 'a' so 'b' becomes LRU (most-recently used = 'c', then 'a').
    pool.touch('a');
    pool.setSize(2);
    expect(pool.size()).toBe(2);
    const occ = pool._stats().occupants;
    expect(occ).toContain('a');
    expect(occ).toContain('c');
    expect(occ).not.toContain('b');
  });

  it('factory throw → returns null, slot not consumed', () => {
    const pool = createWebglContextPool(1);
    const bad = vi.fn(() => {
      throw new Error('GL unavailable');
    });
    const a = pool.acquire('p1', fakeTerm() as never, bad);
    expect(a).toBeNull();
    expect(pool.size()).toBe(0);
    // A working factory after a throw still acquires the slot.
    const good = makeFakeFactory();
    const b = pool.acquire('p1', fakeTerm() as never, good);
    expect(b?.addon).toBeTruthy();
  });

  it('per-pane context-loss cooldown blocks re-acquire within the window', () => {
    const pool = createWebglContextPool(2);
    const f = makeFakeFactory();
    const a = pool.acquire('p1', fakeTerm() as never, f);
    expect(a?.addon).toBeTruthy();
    // Simulate context loss: release with cooldown.
    a?.release({ cooldown: true } as never);
    // Within cooldown: re-acquire returns null even though a slot is free.
    expect(pool.acquire('p1', fakeTerm() as never, f)).toBeNull();
    // After cooldown elapses, re-acquire works.
    vi.advanceTimersByTime(5_000);
    const b = pool.acquire('p1', fakeTerm() as never, f);
    expect(b?.addon).toBeTruthy();
  });
});
