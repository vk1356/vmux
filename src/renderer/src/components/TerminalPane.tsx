import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type MouseEvent
} from 'react';
import { Terminal, type IDisposable, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { Play } from 'lucide-react';
import type { TerminalPane as TerminalPaneT } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useSessionStore } from '../store/sessions';
import { subscribePaneData } from '../store/paneDataBus';
import { useT } from '../i18n';
import { TerminalSearchBar } from './TerminalSearchBar';

interface Props {
  sessionId: string;
  pane: TerminalPaneT;
  active: boolean;
  visible: boolean;
}

/**
 * Exécute `fn` (typiquement `fit.fit()`) tout en préservant la position de
 * lecture si l'user est scrolled-up. Le `Terminal.resize()` interne à fit
 * peut snapper la viewport au bottom — on capture le delta `baseY - viewportY`
 * avant et on restore via `term.scrollLines(-delta)` après.
 */
function withPreservedScroll(term: Terminal, fn: () => void): void {
  const buf = term.buffer.active;
  const delta = buf.baseY - buf.viewportY; // > 0 si scrolled up
  fn();
  if (delta > 0) {
    try {
      term.scrollLines(-delta);
    } catch {
      /* viewport peut avoir disparu pendant fn() (cleanup race) */
    }
  }
}

// Module-level constants — pas de recréation par render (et donc theme/options
// stable côté xterm interne).
const THEME: ITheme = {
  background: '#0a0a0b',
  foreground: '#e4e4e7',
  cursor: '#f97316',
  cursorAccent: '#0a0a0b',
  selectionBackground: 'rgba(249, 115, 22, 0.3)',
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#d946ef',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fde047',
  brightBlue: '#60a5fa',
  brightMagenta: '#e879f9',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa'
};

const IS_WINDOWS = /win/i.test(
  (typeof navigator !== 'undefined' && navigator.platform) || ''
);

/** Cap des bytes pendants quand le pane est invisible. Au-delà on droppe la
 *  moitié la plus ancienne — sinon un agent verbeux off-screen peut leak ~GB. */
const PENDING_CAP_BYTES = 4_000_000;
/** Limite des highlights search — décorateurs au-delà ferait stutter sur de gros buffers. */
const SEARCH_HIGHLIGHT_LIMIT = 1000;

function TerminalPaneImpl({ sessionId, pane, active, visible }: Props): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const ligaturesRef = useRef<LigaturesAddon | null>(null);
  /** Tous les IDisposable owned par ce pane (event handlers xterm). Disposed
   *  dans l'ordre inverse au unmount, AVANT `term.dispose()`. */
  const disposablesRef = useRef<IDisposable[]>([]);
  const pendingRef = useRef<string[]>([]);
  /** Compteur de bytes pending O(1) — évite un scan du tableau à chaque chunk. */
  const pendingBytesRef = useRef(0);

  const settings = useSessionStore((s) => s.settings);
  const isSync = useSessionStore((s) => s.syncSessions.has(sessionId));

  // Refs live lues depuis les hot paths (data-bus, onData) sans déclencher
  // de re-subscribe à chaque flip d'état.
  const visibleRef = useRef(visible);
  const activeRef = useRef(active);
  const isSyncRef = useRef(isSync);
  const sessionIdRef = useRef(sessionId);
  const paneIdRef = useRef(pane.id);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    isSyncRef.current = isSync;
  }, [isSync]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    paneIdRef.current = pane.id;
  }, [pane.id]);

  const [searchOpen, setSearchOpen] = useState(false);
  // Ref miroir : permet au handler keydown de lire la valeur courante sans
  // réinstaller le listener à chaque toggle (anti-thrash de window listeners).
  const searchOpenRef = useRef(false);
  useEffect(() => {
    searchOpenRef.current = searchOpen;
  }, [searchOpen]);
  const [restarting, setRestarting] = useState(false);

  const isInactive = pane.status === 'idle' || pane.status === 'exited' || pane.status === 'error';

  const onRestart = useCallback(async (): Promise<void> => {
    setRestarting(true);
    try {
      await window.cmux.panes.restart(sessionId, pane.id);
    } finally {
      setRestarting(false);
    }
  }, [sessionId, pane.id]);

  // Souscription via le bus IPC unique. 1 seul listener IPC global pour tous
  // les panes (cf. store/paneDataBus.ts). Tant que le pane est invisible on
  // queue (xterm parser ANSI = coûteux même offscreen) ; cap à 4MB.
  useEffect(() => {
    const id = pane.id;
    return subscribePaneData(id, (data) => {
      const term = termRef.current;
      if (term && visibleRef.current) {
        term.write(data);
        return;
      }
      pendingRef.current.push(data);
      pendingBytesRef.current += data.length;
      if (pendingBytesRef.current > PENDING_CAP_BYTES) {
        const arr = pendingRef.current;
        const drop = arr.length >>> 1;
        let dropped = 0;
        for (let i = 0; i < drop; i++) dropped += arr[i].length;
        arr.splice(0, drop);
        pendingBytesRef.current -= dropped;
      }
    });
  }, [pane.id]);

  // Replay du pending buffer quand on redevient visible.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    if (!term) return;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    pendingBytesRef.current = 0;
    // Concat unique → 1 enqueue dans le WriteBuffer xterm au lieu de N.
    // Le parser ANSI maintient son état à travers les write() — équivalent fonctionnel.
    term.write(pending.join(''));
  }, [visible]);

  // ─────────────────────────────────────────────────────────────────────────
  // MOUNT EFFECT — un seul, idempotent. Lit `settings` via ref pour ne PAS
  // re-monter quand un sous-champ change (gérés par les effets live ci-après).
  // ─────────────────────────────────────────────────────────────────────────
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!visible || termRef.current || !hostRef.current) return;
    const s = settingsRef.current;
    if (!s) return;

    const opts: ITerminalOptions = {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      lineHeight: 1.25,
      cursorBlink: s.cursorBlink && visible,
      cursorStyle: 'bar',
      cursorWidth: 2,
      // Pane non-actif → curseur outline (UX cohérente avec Warp/Wezterm).
      cursorInactiveStyle: 'outline',
      scrollback: s.scrollback,
      // smoothScrollDuration + cursorInactiveStyle = proposed API.
      allowProposedApi: true,
      allowTransparency: true,
      smoothScrollDuration: 0,
      scrollOnUserInput: false,
      // Nerd Fonts + glyphes larges peuvent déborder leur cell — rescale via WebGL.
      rescaleOverlappingGlyphs: true,
      // WCAG AA — relève les couleurs dim ANSI si trop proches du background.
      minimumContrastRatio: 4.5,
      theme: THEME,
      ...(IS_WINDOWS ? { windowsPty: { backend: 'conpty' as const } } : {})
    };

    const term = new Terminal(opts);
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    const collected: IDisposable[] = [];

    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        if (!uri || !/^https?:\/\//i.test(uri)) return;
        void window.cmux.dialog.openExternal(uri);
      })
    );
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(search);
    try {
      term.loadAddon(new ClipboardAddon());
    } catch (err) {
      console.warn('[term] ClipboardAddon load failed', err);
    }
    term.open(hostRef.current);

    if (s.webglRenderer) {
      try {
        const webgl = new WebglAddon();
        // ⚠️ context loss : dispose ligatures aussi (lié au renderer canvas/webgl).
        const ctxLost = webgl.onContextLoss(() => {
          try {
            ligaturesRef.current?.dispose();
          } catch {
            /* ignore */
          }
          ligaturesRef.current = null;
          try {
            webgl.dispose();
          } catch {
            /* ignore */
          }
          webglRef.current = null;
        });
        collected.push(ctxLost);
        term.loadAddon(webgl);
        webglRef.current = webgl;
        try {
          const lig = new LigaturesAddon();
          term.loadAddon(lig);
          ligaturesRef.current = lig;
        } catch (err) {
          console.warn('[term] LigaturesAddon load failed', err);
        }
      } catch (err) {
        console.warn('[term] WebGL indisponible, fallback DOM', err);
      }
    }

    try {
      withPreservedScroll(term, () => fit.fit());
    } catch {
      /* ignore */
    }
    window.cmux.panes.resize(pane.id, { cols: term.cols, rows: term.rows });

    // Flush pending accumulé pendant la phase invisible.
    if (pendingRef.current.length > 0) {
      const pending = pendingRef.current;
      pendingRef.current = [];
      pendingBytesRef.current = 0;
      term.write(pending.join(''));
    }

    // onData → garder le IDisposable pour dispose au unmount.
    collected.push(
      term.onData((data) => {
        if (isSyncRef.current) {
          const sess = useSessionStore
            .getState()
            .sessions.find((s) => s.id === sessionIdRef.current);
          if (sess) {
            for (const id of allPaneIds(sess.tree)) {
              const p = sess.panes[id];
              if (p?.kind === 'terminal') window.cmux.panes.write(p.id, data);
            }
            return;
          }
        }
        window.cmux.panes.write(paneIdRef.current, data);
      })
    );

    // Rich paste — Ctrl/Cmd+V intercepte avant le default xterm pour gérer
    // images (PNG temp file → path) + texte. attachCustomKeyEventHandler
    // installe UN handler (pas de IDisposable retourné).
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'v'
      ) {
        event.preventDefault();
        void (async () => {
          try {
            const r = await window.cmux.clipboard.readRich();
            // Re-check : l'user a pu fermer le pane pendant le round-trip.
            if (termRef.current !== term) return;
            if (r.kind === 'image') {
              const p = /\s/.test(r.path) ? `"${r.path.replace(/"/g, '\\"')}"` : r.path;
              term.paste(p);
            } else if (r.text) {
              term.paste(r.text);
            }
          } catch (err) {
            console.warn('[term] rich paste failed', err);
          }
        })();
        return false;
      }
      return true;
    });

    if (s.copyOnSelection) {
      // RAF debounce — xterm émet onSelectionChange à chaque render frame
      // quand des données arrivent avec une sélection active. Sans debounce,
      // clipboard.write() (IPC) serait hammered à 60+ Hz pendant un streaming
      // agent → lag visuel sévère sous forte charge.
      let selRaf = 0;
      collected.push(
        term.onSelectionChange(() => {
          if (selRaf) cancelAnimationFrame(selRaf);
          selRaf = requestAnimationFrame(() => {
            selRaf = 0;
            if (termRef.current !== term) return;
            const sel = term.getSelection();
            if (sel) void window.cmux.clipboard.write(sel);
          });
        })
      );
      collected.push({
        dispose(): void {
          if (selRaf) {
            cancelAnimationFrame(selRaf);
            selRaf = 0;
          }
        }
      });
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    disposablesRef.current = collected;
  }, [visible, pane.id]);

  // ResizeObserver debounced via RAF. Single RAF par cycle, gardé en ref pour
  // pouvoir l'annuler au unmount (anti-stale callback sur term disposé).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    let lastCols = -1;
    let lastRows = -1;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit) return;
        try {
          withPreservedScroll(term, () => fit.fit());
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            window.cmux.panes.resize(pane.id, { cols: term.cols, rows: term.rows });
          }
        } catch {
          /* ignore */
        }
      });
    });
    ro.observe(host);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [pane.id]);

  // Re-fit + focus quand on devient actif. RAF annulable pour éviter une
  // callback sur term disposé après un changement de active rapide.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const raf = requestAnimationFrame(() => {
      try {
        withPreservedScroll(term, () => fit.fit());
        const ae = document.activeElement;
        const isFreeFocus =
          !ae || ae === document.body || (ae as HTMLElement).tagName === 'CANVAS';
        const buf = term.buffer.active;
        const isScrolledUp = buf.viewportY < buf.baseY;
        if (isFreeFocus && !isScrolledUp) term.focus();
        window.cmux.panes.resize(pane.id, { cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, pane.id, pane.status]);

  // Pause cursor blink quand le pane n'est plus visible — sinon RAF continu
  // côté xterm sur N panes off-screen.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    const desired = settings.cursorBlink && visible;
    if (term.options.cursorBlink !== desired) term.options.cursorBlink = desired;
  }, [visible, settings?.cursorBlink, settings]);

  // Live settings — chaque champ surveillé indépendamment + fit() seulement
  // si la métrique de cell change (fontFamily/fontSize).
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    if (term.options.fontFamily !== settings.fontFamily) {
      term.options.fontFamily = settings.fontFamily;
    }
    if (term.options.fontSize !== settings.fontSize) {
      term.options.fontSize = settings.fontSize;
    }
    try {
      const fit = fitRef.current;
      if (fit) withPreservedScroll(term, () => fit.fit());
    } catch {
      /* ignore */
    }
  }, [settings?.fontFamily, settings?.fontSize, settings]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    if (term.options.scrollback !== settings.scrollback) {
      term.options.scrollback = settings.scrollback;
    }
  }, [settings?.scrollback, settings]);

  // Live toggle WebGL — mount/unmount à chaud, fallback DOM si échec.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    if (settings.webglRenderer && !webglRef.current) {
      try {
        const webgl = new WebglAddon();
        const ctxLost = webgl.onContextLoss(() => {
          try {
            ligaturesRef.current?.dispose();
          } catch {
            /* ignore */
          }
          ligaturesRef.current = null;
          try {
            webgl.dispose();
          } catch {
            /* ignore */
          }
          webglRef.current = null;
        });
        disposablesRef.current.push(ctxLost);
        term.loadAddon(webgl);
        webglRef.current = webgl;
        try {
          const lig = new LigaturesAddon();
          term.loadAddon(lig);
          ligaturesRef.current = lig;
        } catch (err) {
          console.warn('[term] LigaturesAddon load failed', err);
        }
      } catch (err) {
        console.warn('[term] WebGL enable failed', err);
      }
    } else if (!settings.webglRenderer && webglRef.current) {
      try {
        ligaturesRef.current?.dispose();
      } catch {
        /* ignore */
      }
      ligaturesRef.current = null;
      try {
        webglRef.current.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;
    }
  }, [settings?.webglRenderer, settings]);

  // ─────────────────────────────────────────────────────────────────────────
  // CLEANUP au démontage. Ordre critique :
  //   1. Null `termRef.current` AVANT dispose() pour que les callbacks
  //      asynchrones (paste handlers post-await, custom key handler) bailent.
  //   2. Dispose des IDisposable enregistrés (onData, onSelectionChange,
  //      onContextLoss) — xterm interdit l'inverse (handler dispatch après
  //      dispose du terminal = crash).
  //   3. Dispose des addons enfants (ligatures, webgl) AVANT le terminal —
  //      l'ordre est imposé par xterm v6 (un addon disposé après son terminal
  //      crashe : il accède à `term._core` déjà null).
  //   4. Enfin dispose le terminal lui-même → libère GPU context, buffer,
  //      keypress listener, ResizeSensor interne. SANS ça : leak de ~5-10MB
  //      par pane fermé + un context WebGL bloqué (limite 8 par tab).
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const term = termRef.current;
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;

      const disposables = disposablesRef.current;
      disposablesRef.current = [];
      for (let i = disposables.length - 1; i >= 0; i--) {
        try {
          disposables[i].dispose();
        } catch {
          /* ignore */
        }
      }

      try {
        ligaturesRef.current?.dispose();
      } catch {
        /* ignore */
      }
      ligaturesRef.current = null;
      try {
        webglRef.current?.dispose();
      } catch {
        /* ignore */
      }
      webglRef.current = null;

      try {
        term?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const onContextMenu = useCallback(
    async (e: MouseEvent): Promise<void> => {
      if (!settings?.pasteOnRightClick) return;
      e.preventDefault();
      const term = termRef.current;
      if (!term) return;
      const r = await window.cmux.clipboard.readRich();
      if (termRef.current !== term) return;
      if (r.kind === 'image') {
        const p = /\s/.test(r.path) ? `"${r.path.replace(/"/g, '\\"')}"` : r.path;
        term.paste(p);
      } else if (r.text) {
        term.paste(r.text);
      }
    },
    [settings?.pasteOnRightClick]
  );

  const onDragOver = useCallback((e: DragEvent): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent): void => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const paths = files
        .map((f) => window.cmux.fs.pathForFile(f))
        .filter((p): p is string => !!p)
        .map((p) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p));
      if (paths.length === 0) return;
      window.cmux.panes.write(pane.id, paths.join(' '));
      termRef.current?.focus();
    },
    [pane.id]
  );

  // Raccourcis pane-actif : Ctrl+Shift+F (search), Ctrl+Shift+L (clear),
  // Escape (close search). Listener installé seulement quand actif → 0 cost
  // sur les panes non-actifs.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        termRef.current?.clear();
      } else if (e.key === 'Escape' && searchOpenRef.current) {
        e.preventDefault();
        setSearchOpen(false);
        termRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const onPaneClick = useCallback(() => {
    window.cmux.panes.focus(sessionId, pane.id);
  }, [sessionId, pane.id]);

  const onCloseSearch = useCallback(() => setSearchOpen(false), []);

  return (
    <div
      className={`terminal-pane ${active ? 'active' : ''} ${isSync ? 'sync' : ''}`}
      onClick={onPaneClick}
    >
      <div
        className="terminal-host"
        ref={hostRef}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
      {isInactive && (
        <div className="terminal-overlay">
          <div className="terminal-overlay-card">
            <div className="terminal-overlay-title">
              {pane.status === 'idle'
                ? t('paneIdle')
                : pane.status === 'exited'
                  ? t('paneExited', { code: pane.exitCode ?? 0 })
                  : t('paneError', { code: pane.exitCode ?? -1 })}
            </div>
            <div className="terminal-overlay-sub">
              {pane.status === 'idle' ? t('paneIdleHint') : t('paneExitedHint')}
            </div>
            <button className="btn primary" onClick={onRestart} disabled={restarting}>
              <Play size={14} /> {restarting ? t('paneStarting') : t('paneRestart')}
            </button>
          </div>
        </div>
      )}
      {searchOpen && (
        <TerminalSearchBar searchAddon={searchRef.current} onClose={onCloseSearch} />
      )}
    </div>
  );
}

/** Compare custom pour `React.memo` : ré-render seulement si une prop sémantiquement
 *  utile change. Sans ça, chaque mutation du store Zustand (qui retourne un
 *  nouveau `pane` object) re-rendrait tous les panes. */
function arePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.active === next.active &&
    prev.visible === next.visible &&
    prev.pane.id === next.pane.id &&
    prev.pane.status === next.pane.status &&
    prev.pane.exitCode === next.pane.exitCode
  );
}

export const TerminalPane = memo(TerminalPaneImpl, arePropsEqual);
