import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX
} from 'react';
import type { Pane, PaneTree } from '@shared/types';
import { allPaneIds, type TreePath } from '@shared/tree';
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
  const ctx = useContext(PaneRenderContext);
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
  const paneCount = allPaneIds(tree).length;
  // Lookup agent color : utilisé pour la border-left de chaque pane terminal.
  const agents = useSessionStore((s) => s.agents);
  const agentColorById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.color;
    return map;
  }, [agents]);

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
    <PaneRenderContext.Provider value={ctx}>
      <TreeNode tree={tree} path={EMPTY_PATH} />
    </PaneRenderContext.Provider>
  );
}

const EMPTY_PATH: TreePath = [];

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

const SplitNode = memo(function SplitNode({ tree, path }: SplitProps): JSX.Element {
  const { sessionId } = usePaneCtx();
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(tree.sizes);
  const draggingRef = useRef<{ leftIndex: number; startSizes: number[]; startPos: number } | null>(
    null
  );

  // Sync depuis le store quand l'arbre change.
  useEffect(() => {
    if (!draggingRef.current) setSizes(tree.sizes);
  }, [tree.sizes.join(',')]);

  const onMouseDownHandle = useCallback(
    (leftIndex: number) => (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = {
        leftIndex,
        startSizes: [...sizes],
        startPos: tree.direction === 'horizontal' ? e.clientX : e.clientY
      };
      document.body.style.cursor = tree.direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.classList.add('split-dragging');
    },
    [sizes, tree.direction]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = draggingRef.current;
      const cont = containerRef.current;
      if (!drag || !cont) return;
      const rect = cont.getBoundingClientRect();
      const total = tree.direction === 'horizontal' ? rect.width : rect.height;
      const cur = tree.direction === 'horizontal' ? e.clientX : e.clientY;
      const deltaPx = cur - drag.startPos;
      const deltaPct = (deltaPx / total) * 100;

      const newSizes = [...drag.startSizes];
      const a = drag.leftIndex;
      const b = drag.leftIndex + 1;
      const sum = newSizes[a] + newSizes[b];
      const newA = Math.max(5, Math.min(sum - 5, drag.startSizes[a] + deltaPct));
      const newB = sum - newA;
      newSizes[a] = newA;
      newSizes[b] = newB;
      setSizes(newSizes);
    };
    const onUp = (): void => {
      const drag = draggingRef.current;
      if (!drag) return;
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.classList.remove('split-dragging');
      void window.cmux.panes.resizeSplit(sessionId, path, sizes);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sessionId, path, sizes, tree.direction]);

  const flexDir = tree.direction === 'horizontal' ? 'row' : 'column';

  return (
    <div className="pane-split" style={{ flexDirection: flexDir }} ref={containerRef}>
      {tree.children.map((child, i) => {
        const size = sizes[i] ?? 100 / tree.children.length;
        // Clé stable : déduite du contenu du sous-arbre, pas de l'index.
        // key={i} causait un remount du <TerminalPane> quand on fermait un
        // pane au milieu (les enfants suivants se décalaient → React pensait
        // qu'ils avaient changé de type). Maintenant on dérive une clé du
        // premier paneId du sous-arbre, ce qui reste stable au reorder.
        const stableKey = subtreeKey(child);
        return (
          <RowFragment
            key={stableKey}
            isLast={i === tree.children.length - 1}
            size={size}
            direction={tree.direction}
            onHandleDown={onMouseDownHandle(i)}
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
  isLast: boolean;
  size: number;
  direction: 'horizontal' | 'vertical';
  onHandleDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}

function RowFragment({
  isLast,
  size,
  direction,
  onHandleDown,
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
          onMouseDown={onHandleDown}
          aria-hidden
        />
      )}
    </>
  );
}
