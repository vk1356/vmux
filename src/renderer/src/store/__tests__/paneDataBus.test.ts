import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake window.cmux.panes.onData — emits via a captured callback.
let lastDataCb: ((paneId: string, data: Uint8Array) => void) | null = null;

vi.stubGlobal('window', {
  cmux: {
    panes: {
      onData: (cb: (paneId: string, data: Uint8Array) => void) => {
        lastDataCb = cb;
        return () => {
          lastDataCb = null;
        };
      }
    }
  }
});

import {
  subscribePaneData,
  snapshotRetained,
  clearPaneData,
  teardownPaneDataBus,
  _paneDataBusStats
} from '../paneDataBus';

function emit(paneId: string, bytes: number[]): void {
  lastDataCb?.(paneId, new Uint8Array(bytes));
}

beforeEach(() => {
  teardownPaneDataBus();
  lastDataCb = null;
});

describe('paneDataBus retained ring', () => {
  it('tees delivered chunks into the retained ring (live subscribe path)', () => {
    const seen: Uint8Array[] = [];
    subscribePaneData('p', (d) => seen.push(d));
    emit('p', [1, 2, 3]);
    emit('p', [4, 5]);
    expect(seen).toHaveLength(2);
    const snap = snapshotRetained('p');
    expect(snap).not.toBeNull();
    expect(Array.from(snap as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it('retains chunks even when no subscriber is present for that pane (queued path)', () => {
    // ensureInstalled is triggered by ANY subscribe — subscribe to a
    // different pane so the global listener is wired but `p` has no handler.
    subscribePaneData('other', () => {});
    emit('p', [9, 8, 7]); // no subscriber for 'p' → goes to pending AND retained
    const snap = snapshotRetained('p');
    expect(Array.from(snap as Uint8Array)).toEqual([9, 8, 7]);
  });

  it('snapshotRetained returns null for a pane with no history', () => {
    expect(snapshotRetained('never-seen')).toBeNull();
  });

  it('clearPaneData clears retained + pending + subscription', () => {
    subscribePaneData('p', () => {});
    emit('p', [1]);
    expect(_paneDataBusStats().retained).toBe(1);
    clearPaneData('p');
    expect(_paneDataBusStats().retained).toBe(0);
    expect(snapshotRetained('p')).toBeNull();
  });

  it('prefixes a full-reset (ESC c) when the ring was truncated', () => {
    // Force truncation by pushing past RETAIN_CAP_BYTES (2 MiB).
    subscribePaneData('p', () => {});
    const oneMb = new Uint8Array(1024 * 1024);
    // 3 × 1 MiB → exceeds 2 MiB cap → head dropped → truncated flag.
    emit('p', Array.from(oneMb));
    emit('p', Array.from(oneMb));
    emit('p', Array.from(oneMb));
    const snap = snapshotRetained('p');
    expect(snap).not.toBeNull();
    const s = snap as Uint8Array;
    expect(s[0]).toBe(0x1b); // ESC
    expect(s[1]).toBe(0x63); // 'c' — RIS full reset
    expect(s.byteLength).toBeLessThanOrEqual(2 + 2 * 1024 * 1024 + 1024 * 1024);
  });

  it('stats include the retained section', () => {
    subscribePaneData('p', () => {});
    emit('p', [1, 2, 3]);
    const s = _paneDataBusStats();
    expect(s.retained).toBe(1);
    expect(s.retainedBytes).toBe(3);
  });
});
