import type { PaneId, PaneTree, SplitDirection } from './types';

/** Chemin dans l'arbre depuis la racine — index dans children à chaque niveau. */
export type TreePath = readonly number[];

/**
 * Trouve le path d'un leaf identifié par paneId. null si pas trouvé.
 *
 * Implem itérative + mutation locale d'un buffer : l'ancienne version créait un
 * nouveau tableau via `[...path, i]` à chaque récursion, soit O(d²) en alloc
 * pour un arbre de profondeur d. Ici on push/pop sur un seul buffer puis on
 * slice à la fin → O(d) alloc, une seule fois.
 */
export function findPath(tree: PaneTree, paneId: PaneId): TreePath | null {
  const buf: number[] = [];

  const walk = (node: PaneTree): boolean => {
    if (node.kind === 'leaf') return node.paneId === paneId;
    for (let i = 0; i < node.children.length; i++) {
      buf.push(i);
      if (walk(node.children[i])) return true;
      buf.pop();
    }
    return false;
  };

  return walk(tree) ? buf.slice() : null;
}

/** Liste tous les paneIds dans l'arbre, ordre depth-first. */
export function allPaneIds(tree: PaneTree): PaneId[] {
  const out: PaneId[] = [];
  const walk = (node: PaneTree): void => {
    if (node.kind === 'leaf') {
      out.push(node.paneId);
      return;
    }
    for (const c of node.children) walk(c);
  };
  walk(tree);
  return out;
}

/** Distribution équitable : N tailles à 100/N% (avec rounding sur la dernière). */
function equalSizes(n: number): number[] {
  const base = Math.floor(100 / n);
  const sizes = new Array<number>(n).fill(base);
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
  // On utilise findPath plutôt que containsPane pour éviter une double-traversée :
  // findPath retourne null si absent, sinon on connaît déjà l'index direct.
  const subPath = findPath(tree, paneId);
  if (!subPath || subPath.length === 0) return tree;
  const idx = subPath[0];

  const child = tree.children[idx];

  // Cas flatten : enfant direct = leaf et split même direction → ajoute sibling.
  if (child.kind === 'leaf' && child.paneId === paneId && tree.direction === direction) {
    const newChildren: PaneTree[] = [
      ...tree.children.slice(0, idx + 1),
      { kind: 'leaf', paneId: newPaneId },
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

/** Supprime un pane de l'arbre. Si le split parent ne contient plus qu'un enfant, il est aplati. Renvoie null si on a tout vidé. */
export function removePane(tree: PaneTree, paneId: PaneId): PaneTree | null {
  if (tree.kind === 'leaf') return tree.paneId === paneId ? null : tree;
  const survivors: PaneTree[] = [];
  const survivingSizes: number[] = [];
  for (let i = 0; i < tree.children.length; i++) {
    const r = removePane(tree.children[i], paneId);
    if (r) {
      survivors.push(r);
      // Invariant : sizes.length === children.length. Si violé, on est sur un
      // tree corrompu : fallback explicite à 100/N plutôt que NaN.
      const s = tree.sizes[i];
      survivingSizes.push(Number.isFinite(s) ? s : 100 / tree.children.length);
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
    // Refuse les inputs avec valeurs négatives ou non-finies : sinon la
    // normalisation produit des tailles aberrantes (>100 ou <0) qui cassent
    // le rendu (flex-basis avec une valeur négative se comporte mal).
    if (sizes.some((s) => !Number.isFinite(s) || s < 0)) return tree;
    const total = sizes.reduce((s, v) => s + v, 0);
    if (total <= 0) return tree;
    return { ...tree, sizes: sizes.map((s) => (s / total) * 100) };
  }
  if (tree.kind === 'leaf') return tree;
  const [head, ...rest] = path;
  const newChildren = tree.children.map((c, i) => (i === head ? setSplitSizes(c, rest, sizes) : c));
  return { ...tree, children: newChildren };
}

/** Directions cardinales de navigation entre panes. */
export type CardinalDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Trouve le voisin dans une direction cardinale donnée (Alt+flèches).
 */
export function neighborInDirection(
  tree: PaneTree,
  paneId: PaneId,
  direction: CardinalDirection
): PaneId | null {
  const path = findPath(tree, paneId);
  if (!path) return null;

  const wantSplit: SplitDirection =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const wantPrev = direction === 'left' || direction === 'up';

  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = nodeAt(tree, path, i);
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

/**
 * Descend un path jusqu'à la profondeur `limit` (exclusive). Évite de
 * matérialiser un sub-array du path comme le faisait l'ancienne version
 * (`path.slice(0, i)` → O(d) alloc à chaque ancêtre testé, soit O(d²) en
 * worst-case pour neighborInDirection).
 */
function nodeAt(tree: PaneTree, path: TreePath, limit: number = path.length): PaneTree | null {
  let cur: PaneTree = tree;
  for (let i = 0; i < limit; i++) {
    if (cur.kind !== 'split') return null;
    const step = path[i];
    // Garde-fou : si le path est corrompu (ex: persisté avec un index obsolète
    // après refactoring du tree), on retourne null au lieu de undefined → null.
    if (step < 0 || step >= cur.children.length) return null;
    cur = cur.children[step];
  }
  return cur;
}

/** Descend dans l'arbre en suivant le bord visuel opposé à la direction de navigation. */
function findEdgeLeaf(tree: PaneTree, direction: CardinalDirection): PaneId {
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

/** Le 1er leaf rencontré (utile quand on ferme l'active pane → focus fallback).
 *  Guard de profondeur : un tree persisté corrompu (cycle, ou split sans
 *  children) ne doit pas crash le renderer en stack-overflow. */
export function firstLeaf(tree: PaneTree, depth = 0): PaneId {
  if (depth > 64) throw new Error('firstLeaf: tree corruption — depth limit');
  if (tree.kind === 'leaf') return tree.paneId;
  if (!tree.children || tree.children.length === 0) {
    throw new Error('firstLeaf: split with no children');
  }
  return firstLeaf(tree.children[0], depth + 1);
}
