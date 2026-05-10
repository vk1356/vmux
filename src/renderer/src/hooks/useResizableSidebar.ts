import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from '@shared/utils';

interface ResizableSidebar {
  /** Largeur en px (clamp dans [min, max]). */
  widthPx: number;
  /** Setter direct (utile pour init depuis settings). */
  setWidthPx: (px: number) => void;
  /** Handler à attacher au mousedown du resize-handle. */
  startDrag: () => void;
  /** Collapse ON/OFF — auto-collapse < threshold sauf si l'user a explicitement
   *  togglé. */
  collapsed: boolean;
  /** Toggle manuel — désactive l'auto-collapse pour cette session. */
  toggleCollapsed: () => void;
}

interface Options {
  min: number;
  max: number;
  initial: number;
  /** Largeur en-dessous de laquelle on auto-collapse. */
  autoCollapseThreshold: number;
  /** Persist le ratio (% de la fenêtre) en settings. */
  onPersistRatio: (pct: number) => void;
}

/**
 * Sidebar resizable :
 * - drag sur le handle (mousemove + mouseup global)
 * - persist le ratio en pourcentage à la fin du drag
 * - auto-collapse responsive avec respect du toggle manuel
 *
 * Extrait d'App.tsx pour cloisonner ~50 lignes de plomberie DOM.
 */
export function useResizableSidebar(opts: Options): ResizableSidebar {
  const [widthPx, setWidthPx] = useState(opts.initial);
  const [collapsed, setCollapsed] = useState(false);
  const draggingRef = useRef(false);
  const userToggledRef = useRef(false);

  // Drag handlers globaux — re-attachés à chaque change de widthPx pour
  // capturer la valeur courante au moment du up.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      const px = clamp(e.clientX, opts.min, opts.max);
      setWidthPx(px);
    };
    const onUp = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      const pct = Math.round((widthPx / window.innerWidth) * 100);
      opts.onPersistRatio(pct);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [widthPx, opts]);

  const startDrag = useCallback((): void => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  // Auto-collapse quand la fenêtre est étroite (mobile-like).
  useEffect(() => {
    const onResize = (): void => {
      if (userToggledRef.current) return;
      const w = window.innerWidth;
      setCollapsed((cur) => {
        const shouldCollapse = w < opts.autoCollapseThreshold;
        return shouldCollapse !== cur ? shouldCollapse : cur;
      });
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [opts.autoCollapseThreshold]);

  const toggleCollapsed = useCallback((): void => {
    userToggledRef.current = true;
    setCollapsed((c) => !c);
  }, []);

  return { widthPx, setWidthPx, startDrag, collapsed, toggleCollapsed };
}
