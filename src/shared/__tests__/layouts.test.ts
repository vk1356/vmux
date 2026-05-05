import { describe, expect, it } from 'vitest';
import { allPaneIds } from '../tree';
import {
  applyLayout,
  evenHorizontalLayout,
  evenVerticalLayout,
  mainStackLayout,
  tileLayout
} from '../layouts';

describe('layouts', () => {
  describe('tileLayout', () => {
    it('1 pane → leaf', () => {
      const t = tileLayout(['a']);
      expect(t).toEqual({ kind: 'leaf', paneId: 'a' });
    });

    it('2 panes → horizontal split 50/50', () => {
      const t = tileLayout(['a', 'b']);
      expect(t.kind).toBe('split');
      if (t.kind !== 'split') return;
      expect(t.direction).toBe('horizontal');
      expect(t.children.length).toBe(2);
      expect(t.sizes).toEqual([50, 50]);
    });

    it('4 panes → 2x2 grid', () => {
      const t = tileLayout(['a', 'b', 'c', 'd']);
      // root = vertical split with 2 rows
      expect(t.kind).toBe('split');
      if (t.kind !== 'split') return;
      expect(t.direction).toBe('vertical');
      expect(t.children.length).toBe(2);
      // each row = horizontal split with 2 panes
      for (const row of t.children) {
        expect(row.kind).toBe('split');
        if (row.kind !== 'split') return;
        expect(row.direction).toBe('horizontal');
        expect(row.children.length).toBe(2);
      }
      expect(allPaneIds(t)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('5 panes → 3 + 2 grid', () => {
      const t = tileLayout(['a', 'b', 'c', 'd', 'e']);
      expect(t.kind).toBe('split');
      if (t.kind !== 'split') return;
      expect(t.direction).toBe('vertical');
      expect(t.children.length).toBe(2);
      const [first, second] = t.children;
      if (first.kind !== 'split') throw new Error();
      expect(first.children.length).toBe(3);
      expect(second.kind).toBe('split');
      if (second.kind !== 'split') return;
      expect(second.children.length).toBe(2);
    });

    it('9 panes → 3x3 grid', () => {
      const t = tileLayout(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
      expect(t.kind).toBe('split');
      if (t.kind !== 'split') return;
      expect(t.children.length).toBe(3);
      for (const row of t.children) {
        if (row.kind !== 'split') throw new Error();
        expect(row.children.length).toBe(3);
      }
    });

    it('preserves all pane ids', () => {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      expect(allPaneIds(tileLayout(ids))).toEqual(ids);
    });
  });

  describe('evenHorizontalLayout', () => {
    it('places all panes in one row', () => {
      const t = evenHorizontalLayout(['a', 'b', 'c']);
      expect(t.kind).toBe('split');
      if (t.kind !== 'split') return;
      expect(t.direction).toBe('horizontal');
      expect(t.children.length).toBe(3);
    });
  });

  describe('evenVerticalLayout', () => {
    it('stacks all panes vertically', () => {
      const t = evenVerticalLayout(['a', 'b', 'c']);
      if (t.kind !== 'split') throw new Error();
      expect(t.direction).toBe('vertical');
    });
  });

  describe('mainStackLayout', () => {
    it('1 pane → leaf', () => {
      expect(mainStackLayout(['a'])).toEqual({ kind: 'leaf', paneId: 'a' });
    });

    it('main left + stacked right', () => {
      const t = mainStackLayout(['m', 'a', 'b', 'c']);
      if (t.kind !== 'split') throw new Error();
      expect(t.direction).toBe('horizontal');
      expect(t.sizes).toEqual([60, 40]);
      const [main, stack] = t.children;
      expect(main).toEqual({ kind: 'leaf', paneId: 'm' });
      if (stack.kind !== 'split') throw new Error();
      expect(stack.direction).toBe('vertical');
      expect(stack.children.length).toBe(3);
    });
  });

  describe('applyLayout', () => {
    it('dispatches to the right algorithm', () => {
      expect(applyLayout('tiled', ['a', 'b']).kind).toBe('split');
      expect(applyLayout('even-horizontal', ['a', 'b', 'c']).kind).toBe('split');
      expect(applyLayout('even-vertical', ['a', 'b']).kind).toBe('split');
      expect(applyLayout('main-stack', ['a', 'b']).kind).toBe('split');
    });
  });
});
