import { describe, expect, it } from 'vitest';
import {
  allPaneIds,
  findPath,
  firstLeaf,
  neighborInDirection,
  removePane,
  setSplitSizes,
  splitAt
} from '../tree';
import type { PaneTree } from '../types';

const leaf = (paneId: string): PaneTree => ({ kind: 'leaf', paneId });

describe('tree', () => {
  describe('splitAt', () => {
    it('splits a single leaf into a 50/50 split', () => {
      const t = leaf('a');
      const r = splitAt(t, 'a', 'horizontal', 'b');
      expect(r).toEqual({
        kind: 'split',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [leaf('a'), leaf('b')]
      });
    });

    it('flattens N siblings when splitting in same direction', () => {
      // Start with 2 horizontal panes, split the right one horizontally → 3 siblings
      let t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      t = splitAt(t, 'b', 'horizontal', 'c');
      expect(t.kind).toBe('split');
      if (t.kind !== 'split') return;
      expect(t.children.length).toBe(3);
      expect(t.children.map((c) => (c.kind === 'leaf' ? c.paneId : null))).toEqual(['a', 'b', 'c']);
      // sizes equal
      expect(t.sizes.every((s) => Math.abs(s - 100 / 3) < 1)).toBe(true);
    });

    it('creates nested split when direction differs', () => {
      let t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      // Split 'b' vertically (different direction) → b becomes a vertical split
      t = splitAt(t, 'b', 'vertical', 'c');
      expect(t.kind).toBe('split');
      if (t.kind !== 'split' || t.children.length !== 2) return;
      expect(t.direction).toBe('horizontal');
      const right = t.children[1];
      expect(right.kind).toBe('split');
      if (right.kind !== 'split') return;
      expect(right.direction).toBe('vertical');
      expect(right.children.length).toBe(2);
    });
  });

  describe('removePane', () => {
    it('removes a leaf and collapses split if last sibling', () => {
      const t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      const r = removePane(t, 'b');
      expect(r).toEqual(leaf('a'));
    });

    it('returns null when removing the only pane', () => {
      expect(removePane(leaf('a'), 'a')).toBeNull();
    });

    it('keeps N-1 siblings when removing one of N>2', () => {
      let t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      t = splitAt(t, 'b', 'horizontal', 'c');
      const r = removePane(t, 'b');
      expect(r?.kind).toBe('split');
      if (r?.kind !== 'split') return;
      expect(r.children.length).toBe(2);
      expect(allPaneIds(r)).toEqual(['a', 'c']);
    });
  });

  describe('findPath / firstLeaf / allPaneIds', () => {
    it('finds path of a leaf', () => {
      const t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      expect(findPath(t, 'a')).toEqual([0]);
      expect(findPath(t, 'b')).toEqual([1]);
      expect(findPath(t, 'missing')).toBeNull();
    });

    it('firstLeaf returns the leftmost leaf', () => {
      const t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      expect(firstLeaf(t)).toBe('a');
    });

    it('allPaneIds returns leaves in DFS order', () => {
      let t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      t = splitAt(t, 'b', 'horizontal', 'c');
      expect(allPaneIds(t)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('setSplitSizes', () => {
    it('updates the root split sizes', () => {
      const t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      const r = setSplitSizes(t, [], [70, 30]);
      expect(r.kind).toBe('split');
      if (r.kind !== 'split') return;
      expect(r.sizes[0]).toBeCloseTo(70);
      expect(r.sizes[1]).toBeCloseTo(30);
    });
  });

  describe('neighborInDirection', () => {
    it('finds right neighbor in horizontal split', () => {
      const t = splitAt(leaf('a'), 'a', 'horizontal', 'b');
      expect(neighborInDirection(t, 'a', 'right')).toBe('b');
      expect(neighborInDirection(t, 'b', 'left')).toBe('a');
      expect(neighborInDirection(t, 'a', 'left')).toBeNull();
    });

    it('finds down neighbor in vertical split', () => {
      const t = splitAt(leaf('a'), 'a', 'vertical', 'b');
      expect(neighborInDirection(t, 'a', 'down')).toBe('b');
      expect(neighborInDirection(t, 'b', 'up')).toBe('a');
    });
  });
});
