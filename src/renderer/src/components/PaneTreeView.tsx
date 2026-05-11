import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react';
import type { Pane, PaneTree } from '@shared/types';
import type { TreePath } from '@shared/tree';
import { TerminalPane } from './TerminalPane';
import { PreviewPane } from './PreviewPane';
import { ErrorBoundary } from './ErrorBoundary';
import { PaneHeader } from './PaneHeader';
import { useSessionStore } from '../store/sessions';

interface Props {
  sessionId: string;
  tree: PaneTree;
  panes: Record<string, Pane>;
  activePaneId?: string;
  visible: boolean;
}

/**
 * Context "render-time" pour panes + agentColorById + showHeaders.
 * Évite de propager 3 props à travers chaque niveau de l'arbre, donc le memo
 * sur TreeNode ne casse pas dès qu'on creuse de 2-3 niveaux.
 */
interface PaneRenderCtx {
  sessionId: string;
  panes: Record<string, Pane>;
  activePaneId?: string;
  visible: boolean;
  showHeaders: boolean;
  agentColorById: Record<string, string>;
}

const PaneRenderContext = createContext<PaneRenderCtx | null>(null);

function usePaneCtx(): PaneRenderCtx {
  // React 19 `use(Context)` — équivalent à useContext mais utilisable
  // conditionnellement et avec une meilleure ergonomie pour les error paths.
  const ctx = use(PaneRenderContext);
  if (!ctx) throw new Error('PaneRenderContext missing — wrap with provider');
  return ctx;
}

export function PaneTreeView({
  sessionId,
  tree,
  panes,
  activePaneId,
  visible
}: Props): JSX.Element | null {
  // Lookup agent color : utilisé pour la border-left de chaque pane terminal.
  const agents = useSessionStore((s) => s.agents);
  const agentColorById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.color;
    return map;
  }, [agents]);

  // Compte les leaves en une seule passe — `allPaneIds` alloue un tableau
  // entier dont seule la longueur nous intéresse. Pour de petits arbres c'est
  // négligeable, mais on évite l'alloc à chaque render.
  const paneCount = useMemo(() => countLeaves(tree), [tree]);

  const ctx = useMemo<PaneRenderCtx>(
    () => ({
      sessionId,
      panes,
      activePaneId,
      visible,
      showHeaders: paneCount > 1,
      agentColorById
    }),
    [sessionId, panes, activePaneId, visible, paneCount, agentColorById]
  );

  return (
    <PaneRenderContext value={ctx}>
      <TreeNode tree={tree} path={EMPTY_PATH} />
    </PaneRenderContext>
  );
}

const EMPTY_PATH: TreePath = [];

/** O(n) leaf count, single traversal — used in lieu of `allPaneIds(tree).length`. */
function countLeaves(tree: PaneTree): number {
  if (tree.kind === 'leaf') return 1;
  let n = 0;
  for (const c of tree.children) n += countLeaves(c);
  return n;
}

interface NodeProps {
  tree: PaneTree;
  path: TreePath;
}

const TreeNode = memo(function TreeNode({ tree, path }: NodeProps): JSX.Element | null {
  const { panes, activePaneId, visible, showHeaders, agentColorById, sessionId } = usePaneCtx();
  if (tree.kind === 'leaf') {
    const pane = panes[tree.paneId];
    if (!pane) return null;
    const isActive = pane.id === activePaneId;
    const label =
      pane.kind === 'terminal' ? `Pane ${pane.agentId}` : `Preview ${pane.url}`;
    // Border-left = couleur de l'agent du pane. Désactivée en single-pane
    // (showHeaders=false) — sans split, l'orientation visuelle n'apporte rien.
    // Preview panes : pas d'accent (pas d'agent associé).
    const accent =
      showHeaders && pane.kind === 'terminal' ? agentColorById[pane.agentId] : undefined;
    return (
      <ErrorBoundary scope="pane" label={label}>
        <div
          className={`pane-with-header ${isActive ? 'active' : ''}`}
          style={accent ? { borderLeftColor: accent } : undefined}
          role="group"
          aria-label={label}
        >
          {showHeaders && <PaneHeader sessionId={sessionId} pane={pane} active={isActive} accent={accent} />}
          {pane.kind === 'terminal' ? (
            <TerminalPane sessionId={sessionId} pane={pane} active={isActive} visible={visible} />
          ) : (
            <PreviewPane sessionId={sessionId} pane={pane} active={isActive} visible={visible} />
          )}
        </div>
      </ErrorBoundary>
    );
  }

  return <SplitNode tree={tree} path={path} />;
});

interface SplitProps {
  tree: Extract<PaneTree, { kind: 'split' }>;
  path: TreePath;
}

/** State interne d'un drag de splitter — stocké dans un ref pour ne pas
 *  déclencher de re-render (60+/sec sinon). Le CSS du handle est piloté
 *  uniquement via `style.flexBasis` sur les enfants concernés, écrit en
 *  direct dans le DOM pendant le mousemove. À mouseup, on commit dans le
 *  store via setSizes + IPC. */
interface DragState {
  leftIndex: number;
  startSizes: number[];
  startPos: number;
  totalPx: number;
}

const SplitNode = memo(function SplitNode({ tree, path }: SplitProps): JSX.Element {
  const { sessionId } = usePaneCtx();
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(tree.sizes);
  const dragRef = useRef<DragState | null>(null);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  // Sync depuis le store quand l'arbre change. Compare item-par-item plutôt
  // que `tree.sizes.join(',')` (anti-pattern : produire une string nouvelle à
  // chaque render finit dans le dep array, sans réel gain).
  useEffect(() => {
    if (dragRef.current) return;
    const cur = sizesRef.current;
    if (cur.length === tree.sizes.length && cur.every((v, i) => v === tree.sizes[i])) return;
    setSizes(tree.sizes);
  }, [tree.sizes]);

  // Stable handler — utilise `data-handle-index` plutôt qu'une closure par index,
  // sinon chaque RowFragment reçoit un onMouseDown différent à chaque render.
  const onPointerDownHandle = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const idx = Number(e.currentTarget.dataset.handleIndex);
      if (!Number.isFinite(idx)) return;
      const cont = containerRef.current;
      if (!cont) return;
      e.preventDefault();
      const rect = cont.getBoundingClientRect();
      const total = tree.direction === 'horizontal' ? rect.width : rect.height;
      dragRef.current = {
        leftIndex: idx,
        startSizes: sizesRef.current.slice(),
        startPos: tree.direction === 'horizontal' ? e.clientX : e.clientY,
        totalPx: total
      };
      // Pointer capture : on garde l'event stream même si l'utilisateur sort
      // de l'élément. Remplace `document.addEventListener` global qui leakait
      // si l'unmount avait lieu pendant un drag.
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.cursor = tree.direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.classList.add('split-dragging');
    },
    [tree.direction]
  );

  const onPointerMoveHandle = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = tree.direction === 'horizontal' ? e.clientX : e.clientY;
      const deltaPx = cur - drag.startPos;
      const deltaPct = (deltaPx / drag.totalPx) * 100;
      const a = drag.leftIndex;
      const b = a + 1;
      const sum = drag.startSizes[a] + drag.startSizes[b];
      const newA = Math.max(5, Math.min(sum - 5, drag.startSizes[a] + deltaPct));
      const newB = sum - newA;

      // CRUCIAL : on n'appelle pas setSizes pendant le drag. On écrit le
      // flex-basis directement sur les 2 enfants impactés via leur DOM node,
      // ce qui évite un reconcile React à chaque frame (60+/sec) et empêche
      // tous les TerminalPane de re-render au passage.
      const cont = containerRef.current;
      if (cont) {
        const childA = cont.children[a * 2] as HTMLElement | undefined;
        const childB = cont.children[b * 2] as HTMLElement | undefined;
        if (childA) childA.style.flexBasis = `${newA}%`;
        if (childB) childB.style.flexBasis = `${newB}%`;
      }
    },
    [tree.direction]
  );

  const onPointerUpHandle = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Lit la taille finale depuis le DOM (mise à jour en live pendant move).
      const cont = containerRef.current;
      const newSizes = drag.startSizes.slice();
      if (cont) {
        const a = drag.leftIndex;
        const b = a + 1;
        const childA = cont.children[a * 2] as HTMLElement | undefined;
        const childB = cont.children[b * 2] as HTMLElement | undefined;
        if (childA) newSizes[a] = parseFloat(childA.style.flexBasis) || drag.startSizes[a];
        if (childB) newSizes[b] = parseFloat(childB.style.flexBasis) || drag.startSizes[b];
      }
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* déjà relâché */
      }
      document.body.style.cursor = '';
      document.body.classList.remove('split-dragging');
      setSizes(newSizes);
      void window.cmux.panes.resizeSplit(sessionId, path, newSizes);
    },
    [sessionId, path]
  );

  // Safety : si on unmount pendant un drag (close session, etc.), restaurer
  // le cursor body. PointerCapture est auto-released par le browser.
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        document.body.style.cursor = '';
        document.body.classList.remove('split-dragging');
      }
    };
  }, []);

  const containerStyle = useMemo<CSSProperties>(
    () => ({ flexDirection: tree.direction === 'horizontal' ? 'row' : 'column' }),
    [tree.direction]
  );

  return (
    <div className="pane-split" style={containerStyle} ref={containerRef} role="group">
      {tree.children.map((child, i) => {
        const size = sizes[i] ?? 100 / tree.children.length;
        // Clé stable : déduite du contenu du sous-arbre, pas de l'index.
        // key={i} causait un remount du <TerminalPane> quand on fermait un
        // pane au milieu (les enfants suivants se décalaient → React pensait
        // qu'ils avaient changé de type). Maintenant on dérive une clé du
        // premier paneId du sous-arbre, ce qui reste stable au reorder.
        const stableKey = subtreeKey(child);
        const isLast = i === tree.children.length - 1;
        return (
          <RowFragment
            key={stableKey}
            handleIndex={i}
            isLast={isLast}
            size={size}
            direction={tree.direction}
            onPointerDown={onPointerDownHandle}
            onPointerMove={onPointerMoveHandle}
            onPointerUp={onPointerUpHandle}
          >
            <TreeNode tree={child} path={[...path, i]} />
          </RowFragment>
        );
      })}
    </div>
  );
});

/** Dérive une clé React stable d'un sous-arbre — utilise le 1er paneId rencontré
 *  en DFS. Le 1er leaf reste identifiant tant que ce sous-arbre existe (les
 *  reorder de splits adjacents ne le modifient pas). Suffisant pour que React
 *  préserve l'état (xterm, focus, scroll) à travers les remaniements. */
function subtreeKey(t: PaneTree): string {
  if (t.kind === 'leaf') return `leaf-${t.paneId}`;
  let cur: PaneTree = t;
  // Guard de profondeur : un arbre corrompu (cycle, ou children vide) ne doit
  // pas hanger le renderer thread. 32 niveaux de splits = bien au-delà de tout
  // usage réel (l'UX devient inutilisable au-delà de ~6).
  let depth = 0;
  while (cur.kind === 'split') {
    if (depth++ > 32 || !cur.children || cur.children.length === 0) {
      return `split-corrupt-${depth}`;
    }
    cur = cur.children[0];
  }
  return `split-${cur.paneId}`;
}

interface RowFragmentProps {
  handleIndex: number;
  isLast: boolean;
  size: number;
  direction: 'horizontal' | 'vertical';
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}

const RowFragment = memo(function RowFragment({
  handleIndex,
  isLast,
  size,
  direction,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  children
}: RowFragmentProps): JSX.Element {
  return (
    <>
      <div
        className="pane-split-child"
        style={{ flex: `0 0 ${size}%`, minWidth: 0, minHeight: 0 }}
      >
        {children}
      </div>
      {!isLast && (
        <div
          className={`pane-split-handle pane-split-handle-${direction}`}
          data-handle-index={handleIndex}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="separator"
          aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
          aria-hidden
        />
      )}
    </>
  );
});
