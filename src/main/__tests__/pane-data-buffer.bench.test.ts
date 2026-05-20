// Bench harness for PaneDataBuffer — establishes baseline spew throughput and a
// placeholder for the keystroke-echo latency assertion that P3 (adaptive flush)
// will satisfy. Lives next to the regular tests so `npm test` enforces the
// regime as a regression gate, not a one-off measurement.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaneDataBuffer } from '../pane-data-buffer';

const FLUSH_MS = PaneDataBuffer.FLUSH_INTERVAL_MS; // 16

describe('PaneDataBuffer — perf bench harness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spew baseline: coalesces a flood of chunks into ~1 flush per 16ms tick', () => {
    const buf = new PaneDataBuffer();
    let flushes = 0;
    let bytes = 0;
    buf.on('flush', (_p, combined) => {
      flushes += 1;
      bytes += combined.byteLength;
    });

    // 8 MiB total in 4 KiB chunks, spread across 16 fake-time ticks (≈ one per
    // FLUSH_INTERVAL_MS so the timer fires once per batch). Push 128 chunks
    // per tick (128 × 4 KiB = 512 KiB), advance one flush interval, repeat.
    // Total pushed = 16 × 512 KiB = 8 MiB. Expected flushes ≈ 16 (one per
    // tick). Cap (4 MiB) is generous vs. per-tick 512 KiB so no drop.
    const chunk = new Uint8Array(4 * 1024).fill(0x78); // 'x'
    const ticks = 16;
    const chunksPerTick = 128;
    const totalPushed = ticks * chunksPerTick * chunk.byteLength; // 8 MiB
    for (let t = 0; t < ticks; t++) {
      for (let i = 0; i < chunksPerTick; i++) buf.push('p', chunk);
      vi.advanceTimersByTime(FLUSH_MS);
    }
    // Drain any final pending flush.
    buf.flush();

    expect(flushes).toBeGreaterThan(0);
    expect(flushes).toBeLessThanOrEqual(ticks + 1); // ≤ 17 (one per tick + drain)
    // Bytes delivered equal what we pushed (no cap drop at this volume) — the
    // invariant is "no duplication, no loss without cap".
    expect(bytes).toBe(totalPushed);

    buf.shutdown();
  });

  // P3 (adaptive flush, Task 3.1) will introduce `lastFlushReason` on the
  // buffer + an immediate flush path when (pending < INTERACTIVE_THRESHOLD &&
  // silence > SILENCE_WINDOW_MS). Until then, a single small push after a long
  // idle still pays the full 16ms timer — this assertion is skipped and
  // re-enabled in Task 3.1.
  it.skip('keystroke-echo: tiny push after silence flushes within one tick (P3)', () => {
    const buf = new PaneDataBuffer();
    let flushedAt: number | null = null;
    buf.on('flush', () => {
      flushedAt = Date.now();
    });

    const t0 = Date.now();
    buf.push('p', new Uint8Array([0x58])); // 1 byte 'X' after a long quiet period
    // P3 contract: synchronous flush, no timer wait.
    expect(flushedAt).not.toBeNull();
    expect((flushedAt as unknown as number) - t0).toBeLessThan(2);
    // And the buffer would expose `lastFlushReason === 'interactive'` —
    // referenced here as a string literal to avoid coupling to a not-yet-
    // existent field. The real assertion goes in P3.

    buf.shutdown();
  });
});
