import { describe, it, expect, vi } from 'vitest';
import { createPaneDataDispatcher } from '../pane-data-port';
import { encodeFrame } from '@shared/pane-data-frame';

describe('createPaneDataDispatcher', () => {
  it('delivers a frame to a live subscriber synchronously', () => {
    const d = createPaneDataDispatcher();
    const cb = vi.fn();
    d.subscribe(cb);
    const payload = new Uint8Array([1, 2, 3]);
    d.dispatch(encodeFrame('p1', payload));
    expect(cb).toHaveBeenCalledTimes(1);
    const [paneId, data] = cb.mock.calls[0];
    expect(paneId).toBe('p1');
    expect(Array.from(data as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('buffers frames received before any subscribe, replays on first subscribe', () => {
    const d = createPaneDataDispatcher();
    d.dispatch(encodeFrame('p1', new Uint8Array([0x41])));
    d.dispatch(encodeFrame('p2', new Uint8Array([0x42])));

    const cb = vi.fn();
    d.subscribe(cb);

    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0]).toBe('p1');
    expect(cb.mock.calls[1][0]).toBe('p2');
  });

  it('fans out a single frame to multiple subscribers', () => {
    const d = createPaneDataDispatcher();
    const a = vi.fn();
    const b = vi.fn();
    d.subscribe(a);
    d.subscribe(b);
    d.dispatch(encodeFrame('p', new Uint8Array([9])));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe that stops delivery to that callback only', () => {
    const d = createPaneDataDispatcher();
    const a = vi.fn();
    const b = vi.fn();
    const offA = d.subscribe(a);
    d.subscribe(b);
    offA();
    d.dispatch(encodeFrame('p', new Uint8Array([1])));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not re-replay buffered frames to a second subscriber', () => {
    const d = createPaneDataDispatcher();
    d.dispatch(encodeFrame('p', new Uint8Array([1])));
    const a = vi.fn();
    d.subscribe(a);
    expect(a).toHaveBeenCalledTimes(1); // initial replay
    const b = vi.fn();
    d.subscribe(b);
    expect(b).not.toHaveBeenCalled(); // queue was drained by a
  });

  it('handles a thrower without dropping the frame to other subscribers', () => {
    const d = createPaneDataDispatcher();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    d.subscribe(bad);
    d.subscribe(good);
    d.dispatch(encodeFrame('p', new Uint8Array([1])));
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});
