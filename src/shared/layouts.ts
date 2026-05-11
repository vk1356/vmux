import type { PaneId, PaneTree } from './types';

function equalSizes(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  const sizes = new Array(n).fill(base) as number[];
  sizes[n - 1] = 100 - base * (n - 1);
  return sizes;
}

/**
 * Layout en grille équilibrée 2D.
 * - 1 pane → leaf
 * - N panes → vertical split de R rangées, chaque rangée = horizontal split de C panes
 *   où C = ceil(sqrt(N)), R = ceil(N/C).
 *
 * Exemples :
 * - 4  → 2×2
 * - 5  → 3 + 2
 * - 6  → 3×2
 * - 9  → 3×3
 */
export function tileLayout(paneIds: PaneId[]): PaneTree {
  if (paneIds.length === 0) {
    throw new Error('tileLayout: empty paneIds');
  }
  if (paneIds.length === 1) {
    return { kind: 'leaf', paneId: paneIds[0] };
  }

  const cols = Math.ceil(Math.sqrt(paneIds.length));
  const rows = Math.ceil(paneIds.length / cols);

  const rowTrees: PaneTree[] = [];
  for (let r = 0; r < rows; r++) {
    const rowIds = paneIds.slice(r * cols, (r + 1) * cols);
    if (rowIds.length === 0) continue;
    if (rowIds.length === 1) {
      rowTrees.push({ kind: 'leaf', paneId: rowIds[0] });
    } else {
      rowTrees.push({
        kind: 'split',
        direction: 'horizontal',
        sizes: equalSizes(rowIds.length),
        children: rowIds.map((id) => ({ kind: 'leaf' as const, paneId: id }))
      });
    }
  }

  if (rowTrees.length === 1) return rowTrees[0];
  return {
    kind: 'split',
    direction: 'vertical',
    sizes: equalSizes(rowTrees.length),
    children: rowTrees
  };
}

/** Layout linéaire — toutes les panes sur une ligne. */
export function evenHorizontalLayout(paneIds: PaneId[]): PaneTree {
  if (paneIds.length === 0) throw new Error('evenHorizontalLayout: empty paneIds');
  if (paneIds.length === 1) return { kind: 'leaf', paneId: paneIds[0] };
  return {
    kind: 'split',
    direction: 'horizontal',
    sizes: equalSizes(paneIds.length),
    children: paneIds.map((id) => ({ kind: 'leaf' as const, paneId: id }))
  };
}

/** Layout colonne — toutes les panes empilées. */
export function evenVerticalLayout(paneIds: PaneId[]): PaneTree {
  if (paneIds.length === 0) throw new Error('evenVerticalLayout: empty paneIds');
  if (paneIds.length === 1) return { kind: 'leaf', paneId: paneIds[0] };
  return {
    kind: 'split',
    direction: 'vertical',
    sizes: equalSizes(paneIds.length),
    children: paneIds.map((id) => ({ kind: 'leaf' as const, paneId: id }))
  };
}

/** Layout main+stack — 1ère pane à gauche en grand, autres empilées à droite. */
export function mainStackLayout(paneIds: PaneId[]): PaneTree {
  if (paneIds.length <= 1) return tileLayout(paneIds);
  const [main, ...rest] = paneIds;
  const stack: PaneTree =
    rest.length === 1
      ? { kind: 'leaf', paneId: rest[0] }
      : {
          kind: 'split',
          direction: 'vertical',
          sizes: equalSizes(rest.length),
          children: rest.map((id) => ({ kind: 'leaf' as const, paneId: id }))
        };
  return {
    kind: 'split',
    direction: 'horizontal',
    sizes: [60, 40],
    children: [{ kind: 'leaf', paneId: main }, stack]
  };
}

export type LayoutPreset = 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-stack';

export function applyLayout(preset: LayoutPreset, paneIds: PaneId[]): PaneTree {
  switch (preset) {
    case 'tiled':
      return tileLayout(paneIds);
    case 'even-horizontal':
      return evenHorizontalLayout(paneIds);
    case 'even-vertical':
      return evenVerticalLayout(paneIds);
    case 'main-stack':
      return mainStackLayout(paneIds);
  }
}
