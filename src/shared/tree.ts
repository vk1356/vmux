import type { PaneId, PaneTree, SplitDirection } from './types';

/** Chemin dans l'arbre depuis la racine — index dans children à chaque niveau. */
export type TreePath = number[];

/** Trouve le path d'un leaf identifié par paneId. null si pas trouvé. */
export function findPath(tree: PaneTree, paneId: PaneId, path: TreePath = []): TreePath | null {
  if (tree.kind === 'leaf') return tree.paneId === paneId ? path : null;
  for (let i = 0; i < tree.children.length; i++) {
    const r = findPath(tree.children[i], paneId, [...path, i]);
    if (r) return r;
  }
  return null;
}

/** Liste tous les paneIds dans l'arbre, ordre depth-first. */
export function allPaneIds(tree: PaneTree): PaneId[] {
  if (tree.kind === 'leaf') return [tree.paneId];
  return tree.children.flatMap(allPaneIds);
}

/** Distribution équitable : N tailles à 100/N% (avec rounding sur la dernière). */
function equalSizes(n: number): number[] {
  const base = Math.floor(100 / n);
  const sizes = new Array(n).fill(base) as number[];
  sizes[n - 1] = 100 - base * (n - 1);
  return sizes;
}

/**
 * Split un pane.
 * - Si le PARENT du pane est un split de la même direction → on ajoute le nouveau
 *   pane comme sibling (flatten N-enfants). Toutes les tailles sont rééquilibrées.
 * - Sinon, on remplace le leaf par un split à 2 enfants à 50/50.
 */
export function splitAt(
  tree: PaneTree,
  paneId: PaneId,
  direction: SplitDirection,
  newPaneId: PaneId
): PaneTree {
  // Cas spécial : si l'arbre lui-même est un leaf → on crée un split racine.
  if (tree.kind === 'leaf') {
    if (tree.paneId !== paneId) return tree;
    return {
      kind: 'split',
      direction,
      sizes: [50, 50],
      children: [
        { kind: 'leaf', paneId: tree.paneId },
        { kind: 'leaf', paneId: newPaneId }
      ]
    };
  }

  // Cherche un enfant qui contient le pane à splitter.
  const idx = tree.children.findIndex((c) => containsPane(c, paneId));
  if (idx === -1) return tree;

  const child = tree.children[idx];

  // Cas flatten : enfant direct = leaf et split même direction → ajoute sibling.
  if (child.kind === 'leaf' && child.paneId === paneId && tree.direction === direction) {
    const newChildren = [
      ...tree.children.slice(0, idx + 1),
      { kind: 'leaf', paneId: newPaneId } as PaneTree,
      ...tree.children.slice(idx + 1)
    ];
    return {
      ...tree,
      children: newChildren,
      sizes: equalSizes(newChildren.length)
    };
  }

  // Sinon : recurse dans le sous-arbre concerné.
  const newChildren = tree.children.map((c, i) =>
    i === idx ? splitAt(c, paneId, direction, newPaneId) : c
  );
  return { ...tree, children: newChildren };
}

function containsPane(tree: PaneTree, paneId: PaneId): boolean {
  if (tree.kind === 'leaf') return tree.paneId === paneId;
  return tree.children.some((c) => containsPane(c, paneId));
}

/** Supprime un pane de l'arbre. Si le split parent ne contient plus qu'un enfant, il est aplati. Renvoie null si on a tout vidé. */
export function removePane(tree: PaneTree, paneId: PaneId): PaneTree | null {
  if (tree.kind === 'leaf') return tree.paneId === paneId ? null : tree;
  const survivors: PaneTree[] = [];
  const survivingSizes: number[] = [];
  for (let i = 0; i < tree.children.length; i++) {
    const r = removePane(tree.children[i], paneId);
    if (r) {
      survivors.push(r);
      survivingSizes.push(tree.sizes[i] ?? 100 / tree.children.length);
    }
  }
  if (survivors.length === 0) return null;
  if (survivors.length === 1) return survivors[0];
  // Renormalise les tailles pour que la somme = 100.
  const total = survivingSizes.reduce((s, v) => s + v, 0) || 1;
  const sizes = survivingSizes.map((s) => (s / total) * 100);
  return { ...tree, children: survivors, sizes };
}

/** Met à jour les tailles d'un split au path donné. Ne touche que ce split. */
export function setSplitSizes(tree: PaneTree, path: TreePath, sizes: number[]): PaneTree {
  if (path.length === 0) {
    if (tree.kind !== 'split') return tree;
    if (sizes.length !== tree.children.length) return tree;
    const total = sizes.reduce((s, v) => s + v, 0) || 1;
    return { ...tree, sizes: sizes.map((s) => (s / total) * 100) };
  }
  if (tree.kind === 'leaf') return tree;
  const [head, ...rest] = path;
  const newChildren = tree.children.map((c, i) => (i === head ? setSplitSizes(c, rest, sizes) : c));
  return { ...tree, children: newChildren };
}

/**
 * Trouve le voisin dans une direction cardinale donnée (Alt+flèches).
 */
export function neighborInDirection(
  tree: PaneTree,
  paneId: PaneId,
  direction: 'left' | 'right' | 'up' | 'down'
): PaneId | null {
  const path = findPath(tree, paneId);
  if (!path) return null;

  const wantSplit: SplitDirection =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const wantPrev = direction === 'left' || direction === 'up';

  for (let i = path.length - 1; i >= 0; i--) {
    const ancestorPath = path.slice(0, i);
    const ancestor = nodeAt(tree, ancestorPath);
    if (!ancestor || ancestor.kind !== 'split') continue;
    if (ancestor.direction !== wantSplit) continue;
    const childIndex = path[i];
    const targetIndex = wantPrev ? childIndex - 1 : childIndex + 1;
    if (targetIndex >= 0 && targetIndex < ancestor.children.length) {
      return findEdgeLeaf(ancestor.children[targetIndex], direction);
    }
  }
  return null;
}

function nodeAt(tree: PaneTree, path: TreePath): PaneTree | null {
  let cur: PaneTree = tree;
  for (const step of path) {
    if (cur.kind !== 'split') return null;
    // Garde-fou : si le path est corrompu (ex: persisté avec un index obsolète
    // après refactoring du tree), on retourne null au lieu de undefined → null.
    if (step < 0 || step >= cur.children.length) return null;
    cur = cur.children[step];
  }
  return cur;
}

/** Descend dans l'arbre en suivant le bord visuel opposé à la direction de navigation. */
function findEdgeLeaf(tree: PaneTree, direction: 'left' | 'right' | 'up' | 'down'): PaneId {
  if (tree.kind === 'leaf') return tree.paneId;
  const wantHorizontal = direction === 'left' || direction === 'right';
  const matchesDir =
    (wantHorizontal && tree.direction === 'horizontal') ||
    (!wantHorizontal && tree.direction === 'vertical');
  if (matchesDir) {
    const idx = direction === 'right' || direction === 'down' ? 0 : tree.children.length - 1;
    return findEdgeLeaf(tree.children[idx], direction);
  }
  return findEdgeLeaf(tree.children[0], direction);
}

/** Le 1er leaf rencontré (utile quand on ferme l'active pane → focus fallback). */
export function firstLeaf(tree: PaneTree): PaneId {
  return tree.kind === 'leaf' ? tree.paneId : firstLeaf(tree.children[0]);
}
