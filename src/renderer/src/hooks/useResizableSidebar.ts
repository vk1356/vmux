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
  // Refs live pour lire les options et la largeur courante dans onUp sans
  // ré-attacher mousemove/mouseup à chaque pixel déplacé. Avant : `[widthPx,
  // opts]` en deps → re-add/remove des handlers à chaque setWidthPx, soit ~1
  // listener add+remove par pixel pendant un drag.
  const widthRef = useRef(widthPx);
  const optsRef = useRef(opts);
  useEffect(() => {
    widthRef.current = widthPx;
  }, [widthPx]);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      // Si le user a relâché le bouton hors de la fenêtre, on rate le mouseup —
      // détecter via e.buttons === 0 et finir le drag en se synchronisant.
      if (e.buttons === 0) {
        finishDrag();
        return;
      }
      const o = optsRef.current;
      const px = clamp(e.clientX, o.min, o.max);
      setWidthPx(px);
    };
    const finishDrag = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      const pct = Math.round((widthRef.current / window.innerWidth) * 100);
      optsRef.current.onPersistRatio(pct);
    };
    const onBlur = (): void => finishDrag();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', finishDrag);
    // Mouse leaks hors Electron window (taskbar, autre écran) : pas de mouseup.
    // window blur OU pointerup global termine proprement le drag.
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerup', finishDrag);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', finishDrag);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerup', finishDrag);
    };
  }, []);

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
