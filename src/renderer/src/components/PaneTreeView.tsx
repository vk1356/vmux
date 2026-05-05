import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { Pane, PaneTree } from '@shared/types';
import { allPaneIds, type TreePath } from '@shared/tree';
import { TerminalPane } from './TerminalPane';
import { PreviewPane } from './PreviewPane';
import { ErrorBoundary } from './ErrorBoundary';
import { PaneHeader } from './PaneHeader';

interface Props {
  sessionId: string;
  tree: PaneTree;
  panes: Record<string, Pane>;
  activePaneId?: string;
  visible: boolean;
}

export function PaneTreeView({
  sessionId,
  tree,
  panes,
  activePaneId,
  visible
}: Props): JSX.Element | null {
  const paneCount = allPaneIds(tree).length;
  return (
    <TreeNode
      sessionId={sessionId}
      tree={tree}
      panes={panes}
      activePaneId={activePaneId}
      path={[]}
      visible={visible}
      showHeaders={paneCount > 1}
    />
  );
}

interface NodeProps {
  sessionId: string;
  tree: PaneTree;
  panes: Record<string, Pane>;
  activePaneId?: string;
  path: TreePath;
  visible: boolean;
  showHeaders: boolean;
}

function TreeNode({
  sessionId,
  tree,
  panes,
  activePaneId,
  path,
  visible,
  showHeaders
}: NodeProps): JSX.Element | null {
  if (tree.kind === 'leaf') {
    const pane = panes[tree.paneId];
    if (!pane) return null;
    const isActive = pane.id === activePaneId;
    const label =
      pane.kind === 'terminal' ? `Pane ${pane.agentId}` : `Preview ${pane.url}`;
    return (
      <ErrorBoundary scope="pane" label={label}>
        <div className="pane-with-header">
          {showHeaders && <PaneHeader sessionId={sessionId} pane={pane} active={isActive} />}
          {pane.kind === 'terminal' ? (
            <TerminalPane sessionId={sessionId} pane={pane} active={isActive} visible={visible} />
          ) : (
            <PreviewPane sessionId={sessionId} pane={pane} active={isActive} />
          )}
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <SplitNode
      sessionId={sessionId}
      tree={tree}
      panes={panes}
      activePaneId={activePaneId}
      path={path}
      visible={visible}
      showHeaders={showHeaders}
    />
  );
}

interface SplitProps extends NodeProps {
  tree: Extract<PaneTree, { kind: 'split' }>;
}

function SplitNode({
  sessionId,
  tree,
  panes,
  activePaneId,
  path,
  visible,
  showHeaders
}: SplitProps): JSX.Element {
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
        return (
          <RowFragment
            key={i}
            isLast={i === tree.children.length - 1}
            size={size}
            direction={tree.direction}
            onHandleDown={onMouseDownHandle(i)}
          >
            <TreeNode
              sessionId={sessionId}
              tree={child}
              panes={panes}
              activePaneId={activePaneId}
              path={[...path, i]}
              visible={visible}
              showHeaders={showHeaders}
            />
          </RowFragment>
        );
      })}
    </div>
  );
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
