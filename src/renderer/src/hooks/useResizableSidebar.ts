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
 * Perf : pendant le drag, mousemove écrit dans un ref + planifie un rAF
 * qui appelle setState UNE fois par frame. Sans rAF, on déclenchait un
 * re-render React par pixel (≥60/s soutenu → 600/s sur trackpad).
 * Le listener mousemove utilise `passive: true` pour ne pas bloquer le
 * compositor sur scroll horizontal.
 */
export function useResizableSidebar(opts: Options): ResizableSidebar {
  const [widthPx, setWidthPx] = useState(opts.initial);
  const [collapsed, setCollapsed] = useState(false);
  const draggingRef = useRef(false);
  const userToggledRef = useRef(false);
  // Refs live pour lire les options et la largeur courante dans onUp sans
  // ré-attacher mousemove/mouseup à chaque pixel déplacé. Assignés en body
  // (avant les effects) pour garantir que les handlers du premier mount
  // voient déjà la bonne valeur — équivalent au pattern useEvent proposal.
  const widthRef = useRef(widthPx);
  widthRef.current = widthPx;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    // rAF coalesce : un seul setState par frame, peu importe le débit
    // d'évents mousemove (trackpads sub-pixel ≥ 240Hz).
    let pendingPx: number | null = null;
    let rafId = 0;

    const flush = (): void => {
      rafId = 0;
      if (pendingPx === null) return;
      const next = pendingPx;
      pendingPx = null;
      widthRef.current = next;
      setWidthPx(next);
    };

    const finishDrag = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      // Force le dernier flush avant de persister, sinon le pct stocké
      // peut être 1 frame en retard sur la position finale du curseur.
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        flush();
      }
      const pct = Math.round((widthRef.current / window.innerWidth) * 100);
      optsRef.current.onPersistRatio(pct);
    };

    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      // Si le user a relâché le bouton hors de la fenêtre, on rate le mouseup —
      // détecter via e.buttons === 0 et finir le drag en se synchronisant.
      if (e.buttons === 0) {
        finishDrag();
        return;
      }
      const o = optsRef.current;
      pendingPx = clamp(e.clientX, o.min, o.max);
      if (rafId === 0) rafId = requestAnimationFrame(flush);
    };

    window.addEventListener('mousemove', onMove, { passive: true, signal });
    window.addEventListener('mouseup', finishDrag, { signal });
    // Mouse leaks hors Electron window (taskbar, autre écran) : pas de mouseup.
    // window blur OU pointerup global termine proprement le drag.
    window.addEventListener('blur', finishDrag, { signal });
    window.addEventListener('pointerup', finishDrag, { signal });

    return () => {
      ac.abort();
      if (rafId !== 0) cancelAnimationFrame(rafId);
      // Si on unmount au milieu d'un drag, restore le curseur sans persister
      // (l'unmount = teardown, pas un endDrag user-intentionnel).
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = '';
      }
    };
  }, []);

  const startDrag = useCallback((): void => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  // Auto-collapse quand la fenêtre est étroite (mobile-like).
  // Threshold lu via ref → un seul listener resize pour la vie du hook.
  useEffect(() => {
    const ac = new AbortController();
    const onResize = (): void => {
      if (userToggledRef.current) return;
      const shouldCollapse = window.innerWidth < optsRef.current.autoCollapseThreshold;
      setCollapsed((cur) => (shouldCollapse !== cur ? shouldCollapse : cur));
    };
    onResize();
    window.addEventListener('resize', onResize, { passive: true, signal: ac.signal });
    return () => ac.abort();
  }, []);

  const toggleCollapsed = useCallback((): void => {
    userToggledRef.current = true;
    setCollapsed((c) => !c);
  }, []);

  // setWidthPxClamped : wrap autour de setWidthPx pour garantir que toute
  // valeur fournie par le code appelant (ex. restauration depuis settings
  // persisté avec une largeur de fenêtre différente, valeur corrompue) reste
  // dans [min, max]. Sans clamp, une valeur out-of-range écrasait state +
  // ref et faisait apparaître la sidebar à une taille invalide jusqu'au
  // prochain drag manuel.
  const setWidthPxClamped = useCallback((px: number): void => {
    const o = optsRef.current;
    const clamped = Math.min(o.max, Math.max(o.min, Number.isFinite(px) ? px : o.initial));
    widthRef.current = clamped;
    setWidthPx(clamped);
  }, []);

  return { widthPx, setWidthPx: setWidthPxClamped, startDrag, collapsed, toggleCollapsed };
}
