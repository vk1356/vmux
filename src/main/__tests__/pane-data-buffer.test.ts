import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PaneDataBuffer } from '../pane-data-buffer';

describe('PaneDataBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple chunks for the same pane into a single flush', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, combined]));

    buf.push('pane-1', 'a');
    buf.push('pane-1', 'b');
    buf.push('pane-1', 'c');

    expect(seen).toHaveLength(0); // pas encore flush

    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toEqual([['pane-1', 'abc']]);
  });

  it('emits a separate flush per pane', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, combined]));

    buf.push('p1', 'foo');
    buf.push('p2', 'bar');

    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual(['p1', 'foo']);
    expect(seen).toContainEqual(['p2', 'bar']);
  });

  it('does not emit empty flush on second tick if no new data', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, combined]));

    buf.push('p1', 'hello');
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);
    expect(seen).toHaveLength(1);

    // No push; advance again — no second timer scheduled, so no second flush.
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS * 5);
    expect(seen).toHaveLength(1);
  });

  it('schedules a new flush when data arrives after the previous flush', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, combined]));

    buf.push('p1', 'first');
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);
    buf.push('p1', 'second');
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toEqual([
      ['p1', 'first'],
      ['p1', 'second']
    ]);
  });

  it('drops the buffer for a deleted pane', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, combined]));

    buf.push('p1', 'foo');
    buf.delete('p1');
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen).toHaveLength(0);
  });

  it('shutdown clears pending timer and buffers', () => {
    const buf = new PaneDataBuffer();
    const seen: Array<[string, string]> = [];
    buf.on('flush', (paneId, combined) => seen.push([paneId, combined]));

    buf.push('p1', 'pending');
    buf.shutdown();
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS * 10);

    expect(seen).toHaveLength(0);
  });

  it('uses single string when only one chunk (no .join overhead)', () => {
    const buf = new PaneDataBuffer();
    const seen: string[] = [];
    buf.on('flush', (_paneId, combined) => seen.push(combined));

    const single = 'only-chunk';
    buf.push('p1', single);
    vi.advanceTimersByTime(PaneDataBuffer.FLUSH_INTERVAL_MS + 1);

    expect(seen[0]).toBe(single);
  });
});
