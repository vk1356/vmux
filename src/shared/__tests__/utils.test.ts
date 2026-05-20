import { describe, it, expect } from 'vitest';
import { concatU8 } from '../utils';

describe('concatU8', () => {
  it('returns the empty Uint8Array for an empty input via single allocation', () => {
    const out = concatU8([]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(0);
  });

  it('returns the same reference on a single-element input (fast path, zero copy)', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(concatU8([a])).toBe(a);
  });

  it('concatenates multiple chunks byte-exact in order', () => {
    const out = concatU8([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
      new Uint8Array([6])
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('handles a large concat without truncation (size sum across chunks)', () => {
    const chunks: Uint8Array[] = [];
    let expected = 0;
    for (let i = 0; i < 50; i++) {
      const c = new Uint8Array(1024);
      c.fill(i & 0xff);
      chunks.push(c);
      expected += 1024;
    }
    const out = concatU8(chunks);
    expect(out.byteLength).toBe(expected);
    // Spot-check boundaries.
    expect(out[0]).toBe(0);
    expect(out[1024]).toBe(1);
    expect(out[expected - 1]).toBe(49 & 0xff);
  });
});
