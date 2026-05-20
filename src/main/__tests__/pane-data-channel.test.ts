import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks for electron-log + electron's MessageChannelMain/BrowserWindow ---
vi.mock('electron-log/main', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

let chanCount = 0;
function makeFakeChannel(): { port1: object; port2: object } {
  chanCount += 1;
  return { port1: { __port1: chanCount }, port2: { __port2: chanCount } };
}

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1: object;
    port2: object;
    constructor() {
      const c = makeFakeChannel();
      this.port1 = c.port1;
      this.port2 = c.port2;
    }
  },
  BrowserWindow: class {} // unused but referenced for type
}));

import { PaneDataChannelManager } from '../pane-data-channel';
import { IPC } from '@shared/types';

// Fake window + supervisor builders.
function makeFakeWindow(id = 1, loading = false) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const wcListeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const wc = {
    isDestroyed: () => false,
    isLoading: () => loading,
    once: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
      (wcListeners[event] ??= []).push(cb);
    }),
    postMessage: vi.fn()
  };
  return {
    id,
    isDestroyed: () => false,
    webContents: wc,
    once: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    _fireClosed: () => listeners.closed?.forEach((cb) => cb()),
    _fireDidFinishLoad: () => wcListeners['did-finish-load']?.forEach((cb) => cb())
  };
}

function makeFakeSupervisor() {
  const respawnCbs: Array<() => void> = [];
  return {
    sup: {
      sendWithPorts: vi.fn(),
      onRespawn: (cb: () => void) => respawnCbs.push(cb)
    },
    fireRespawn: () => respawnCbs.forEach((cb) => cb())
  };
}

beforeEach(() => {
  chanCount = 0;
  vi.clearAllMocks();
});

describe('PaneDataChannelManager', () => {
  it('attaches a window: sends port1 to host and posts port2 to renderer', () => {
    const { sup } = makeFakeSupervisor();
    const mgr = new PaneDataChannelManager(sup as never);
    const win = makeFakeWindow(7, /* loading */ false);

    mgr.attachWindow(win as never);

    // port1 went to host.
    expect(sup.sendWithPorts).toHaveBeenCalledTimes(1);
    const [msg, transfer] = sup.sendWithPorts.mock.calls[0];
    expect(msg).toEqual({ kind: 'attachDataPort' });
    expect((transfer as object[])[0]).toMatchObject({ __port1: expect.any(Number) });

    // port2 went straight to renderer (not loading).
    expect(win.webContents.postMessage).toHaveBeenCalledTimes(1);
    const [channel, payload, ports] = win.webContents.postMessage.mock.calls[0];
    expect(channel).toBe(IPC.paneDataPort);
    expect(payload).toBeNull();
    expect((ports as object[])[0]).toMatchObject({ __port2: expect.any(Number) });

    expect(mgr._stats().count).toBe(1);
    expect(mgr._stats().wins).toEqual([7]);
  });

  it('defers port2 send until did-finish-load when webContents is loading', () => {
    const { sup } = makeFakeSupervisor();
    const mgr = new PaneDataChannelManager(sup as never);
    const win = makeFakeWindow(1, /* loading */ true);

    mgr.attachWindow(win as never);

    // port1 sent immediately to host.
    expect(sup.sendWithPorts).toHaveBeenCalledTimes(1);
    // port2 NOT yet posted to renderer.
    expect(win.webContents.postMessage).not.toHaveBeenCalled();

    // Now fire did-finish-load.
    win._fireDidFinishLoad();
    expect(win.webContents.postMessage).toHaveBeenCalledTimes(1);
  });

  it('drops the entry when the window closes', () => {
    const { sup } = makeFakeSupervisor();
    const mgr = new PaneDataChannelManager(sup as never);
    const win = makeFakeWindow(2);
    mgr.attachWindow(win as never);
    expect(mgr._stats().count).toBe(1);

    win._fireClosed();
    expect(mgr._stats().count).toBe(0);
  });

  it('rebuildAll re-issues fresh channels to all live windows on respawn', () => {
    const { sup, fireRespawn } = makeFakeSupervisor();
    const mgr = new PaneDataChannelManager(sup as never);
    const wA = makeFakeWindow(10);
    const wB = makeFakeWindow(11);
    mgr.attachWindow(wA as never);
    mgr.attachWindow(wB as never);

    expect(sup.sendWithPorts).toHaveBeenCalledTimes(2);
    expect(wA.webContents.postMessage).toHaveBeenCalledTimes(1);
    expect(wB.webContents.postMessage).toHaveBeenCalledTimes(1);

    // Simulate host crash respawn.
    fireRespawn();

    // Two more port pairs sent (one per window). Total: 4.
    expect(sup.sendWithPorts).toHaveBeenCalledTimes(4);
    expect(wA.webContents.postMessage).toHaveBeenCalledTimes(2);
    expect(wB.webContents.postMessage).toHaveBeenCalledTimes(2);
    expect(mgr._stats().wins).toEqual([10, 11]);
  });

  it('rebuildAll skips destroyed windows', () => {
    const { sup, fireRespawn } = makeFakeSupervisor();
    const mgr = new PaneDataChannelManager(sup as never);
    const wA = makeFakeWindow(20);
    const wDead = {
      ...makeFakeWindow(21),
      isDestroyed: () => true
    };
    mgr.attachWindow(wA as never);
    // Manually push the dead window into the entries list to simulate a window
    // that died between attach and respawn (the close handler in the real path
    // would have pruned it, but timing races exist).
    (mgr as unknown as { entries: Array<{ win: object; channel: object }> }).entries.push({
      win: wDead as never,
      channel: { port1: {}, port2: {} }
    });

    sup.sendWithPorts.mockClear();
    fireRespawn();

    // Only the live window got rebuilt.
    expect(sup.sendWithPorts).toHaveBeenCalledTimes(1);
    expect(mgr._stats().wins).toEqual([20]);
  });
});
