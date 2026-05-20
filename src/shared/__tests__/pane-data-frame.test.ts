import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame } from '../pane-data-frame';

describe('pane-data-frame', () => {
  it('round-trips paneId and payload byte-identically', () => {
    const payload = new Uint8Array([0xc3, 0xa9, 0x1b, 0x5b, 0x33, 0x32, 0x6d]); // "é\x1b[32m"
    const ab = encodeFrame('pane-42', payload);
    expect(ab).toBeInstanceOf(ArrayBuffer);

    const out = decodeFrame(ab);
    expect(out.paneId).toBe('pane-42');
    expect(Array.from(out.payload)).toEqual(Array.from(payload));
  });

  it('handles an empty payload', () => {
    const ab = encodeFrame('p', new Uint8Array(0));
    const out = decodeFrame(ab);
    expect(out.paneId).toBe('p');
    expect(out.payload.byteLength).toBe(0);
  });

  it('handles a UTF-8 paneId (Unicode escape, emoji)', () => {
    const id = 'p-é-🚀';
    const payload = new Uint8Array([1, 2, 3]);
    const ab = encodeFrame(id, payload);
    const out = decodeFrame(ab);
    expect(out.paneId).toBe(id);
    expect(Array.from(out.payload)).toEqual([1, 2, 3]);
  });

  it('produces exactly one ArrayBuffer (single transferable)', () => {
    // The output is an ArrayBuffer (not a view) so postMessage([ab]) detaches
    // the whole frame in one call — required for zero-copy on the hot path.
    const ab = encodeFrame('p1', new Uint8Array([0]));
    expect(ab).toBeInstanceOf(ArrayBuffer);
    // Detach simulation: structuredClone with transfer should empty the source.
    const cloned = structuredClone(ab, { transfer: [ab] });
    expect(cloned).toBeInstanceOf(ArrayBuffer);
    expect(ab.byteLength).toBe(0); // source detached
    expect(cloned.byteLength).toBeGreaterThan(0);
  });

  it('handles a large payload without truncation (1 MiB)', () => {
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const ab = encodeFrame('p-big', payload);
    const out = decodeFrame(ab);
    expect(out.paneId).toBe('p-big');
    expect(out.payload.byteLength).toBe(payload.byteLength);
    expect(out.payload[0]).toBe(0);
    expect(out.payload[payload.length - 1]).toBe((payload.length - 1) & 0xff);
  });
});
