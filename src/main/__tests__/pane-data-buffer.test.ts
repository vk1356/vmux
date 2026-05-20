import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PaneDataBuffer } from '../pane-data-buffer';

const u8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('PaneDataBuffer (byte mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple chunks for the same pane into a single flush', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, decode(combined)]));

    buf.push('pane-1', u8('a'));
    buf.push('pane-1', u8('b'));
    buf.push('pane-1', u8('c'));

    expect(seen).toHaveLength(0); // pas encore flush

    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toEqual([['pane-1', 'abc']]);
  });

  it('emits a separate flush per pane', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, decode(combined)]));

    buf.push('p1', u8('foo'));
    buf.push('p2', u8('bar'));

    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(['p1', 'foo']);
    expect(seen).toContainEqual(['p2', 'bar']);
  });

  it('does not emit empty flush on second tick if no new data', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, decode(combined)]));

    buf.push('p1', u8('hello'));
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);
    expect(seen).toHaveLength(1);

    // No push; advance again — no second timer scheduled, so no second flush.
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS * 5);
    expect(seen).toHaveLength(1);
  });

  it('schedules a new flush when data arrives after the previous flush', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, decode(combined)]));

    buf.push('p1', u8('first'));
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);
    buf.push('p1', u8('second'));
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toEqual([
      ['p1', 'first'],
      ['p1', 'second']
    ]);
  });

  it('drops the buffer for a deleted pane', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, decode(combined)]));

    buf.push('p1', u8('foo'));
    buf.delete('p1');
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toHaveLength(0);
  });

  it('shutdown clears pending timer and buffers', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, decode(combined)]));

    buf.push('p1', u8('pending'));
    buf.shutdown();
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS * 10);

    expect(seen).toHaveLength(0);
  });

  it('passes through a single chunk by reference (no concat allocation)', () => {
    const buf = new PaneDataBuffer();
    const seen: Uint8Array[] = [];
    buf.on('flush', (_paneId, combined) => seen.push(combined));

    const single = u8('only-chunk');
    buf.push('p1', single);
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen[0]).toBe(single); // same reference — fast path in concatU8
  });

  it('drops head chunks when total exceeds MAX_PANE_BYTES, preserving tail', () => {
    const buf = new PaneDataBuffer();
    const seen: Uint8Array[] = [];
    buf.on('flush', (_paneId, combined) => seen.push(combined));

    // Push 3 chunks of 2 MiB → 6 MiB > 4 MiB cap. The head (first chunk)
    // should be dropped; tail (last two) preserved.
    const head = new Uint8Array(2 * 1024 * 1024).fill(0x41); // 'A'
    const mid = new Uint8Array(2 * 1024 * 1024).fill(0x42); // 'B'
    const tail = new Uint8Array(2 * 1024 * 1024).fill(0x43); // 'C'
    buf.push('p1', head);
    buf.push('p1', mid);
    buf.push('p1', tail);

    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toHaveLength(1);
    const out = seen[0];
    // Should not include any 'A' bytes (head dropped).
    expect(out.indexOf(0x41)).toBe(-1);
    expect(out.byteLength).toBeLessThanOrEqual(PaneDataBuffer.MAX_PANE_BYTES);
    // Should still contain the tail.
    expect(out[out.byteLength - 1]).toBe(0x43);
  });

  it('strips an orphaned ANSI CSI tail left after a head-drop', () => {
    const buf = new PaneDataBuffer();
    const seen: Uint8Array[] = [];
    buf.on('flush', (_paneId, combined) => seen.push(combined));

    // Force a head-drop scenario: huge head chunk + a follow-up that starts
    // with a CSI param/intermediate sequence (as if the ESC[ was lost in the
    // dropped chunk). "0;32m" → bytes [0x30, 0x3b, 0x33, 0x32, 0x6d].
    const head = new Uint8Array(PaneDataBuffer.MAX_PANE_BYTES + 1024).fill(0x41);
    const orphan = u8('0;32mHello');
    buf.push('p1', head);
    buf.push('p1', orphan);

    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toHaveLength(1);
    const out = seen[0];
    // The orphan "0;32m" should be stripped; only "Hello" tail remains from
    // the orphan chunk (and tail bytes from the truncated head if any).
    const decoded = decode(out);
    expect(decoded.endsWith('Hello')).toBe(true);
    expect(decoded.includes('0;32m')).toBe(false);
  });

  it('ignores empty pushes', () => {
    const buf = new PaneDataBuffer();
    const seen: Uint8Array[] = [];
    buf.on('flush', (_paneId, combined) => seen.push(combined));

    buf.push('p1', new Uint8Array(0));
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);
    expect(seen).toHaveLength(0);
  });
});
