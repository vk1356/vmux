import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { ChevronDown, ChevronUp, X as XIcon, Play } from 'lucide-react';
import type { TerminalPane as TerminalPaneT } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useSessionStore } from '../store/sessions';
import { useT } from '../i18n';

interface Props {
  sessionId: string;
  pane: TerminalPaneT;
  active: boolean;
  visible: boolean;
}

const THEME = {
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
} as const;

function TerminalPaneImpl({ sessionId, pane, active, visible }: Props): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const pendingRef = useRef<string[]>([]);
  const settings = useSessionStore((s) => s.settings);
  const isSync = useSessionStore((s) => s.syncSessions.has(sessionId));
  // Ref live pour lire l'état sync dans des callbacks chauds (term.onData)
  // sans déclencher de re-render à chaque chunk.
  const isSyncRef = useRef(isSync);
  useEffect(() => {
    isSyncRef.current = isSync;
  }, [isSync]);
  const [searchOpen, setSearchOpen] = useState(false);
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

  // Listener IPC enregistré dès le mount.
  useEffect(() => {
    const off = window.cmux.panes.onData((paneId, data) => {
      if (paneId !== pane.id) return;
      const t = termRef.current;
      if (t) t.write(data);
      else pendingRef.current.push(data);
    });
    return off;
  }, [pane.id]);

  // Init xterm — lazy, premier active ou visible.
  useEffect(() => {
    if (!visible || termRef.current || !hostRef.current || !settings) return;

    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: 1.25,
      cursorBlink: settings.cursorBlink,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      allowTransparency: true,
      smoothScrollDuration: 80,
      theme: THEME,
      windowsPty: { backend: 'conpty' }
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    // Handler custom : on valide l'URL et on passe par notre IPC pour
    // ouvrir dans le browser système (sinon shell.openExternal peut être
    // appelé avec une URL malformée et Windows affiche "lien about").
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!uri || !/^https?:\/\//i.test(uri)) return;
        void window.cmux.dialog.openExternal(uri);
      })
    );
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(search);
    term.open(hostRef.current);

    if (settings.webglRenderer) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglRef.current = null;
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch (err) {
        console.warn('[term] WebGL indisponible, fallback DOM', err);
      }
    }

    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    window.cmux.panes.resize(pane.id, { cols: term.cols, rows: term.rows });

    for (const chunk of pendingRef.current) term.write(chunk);
    pendingRef.current = [];

    term.onData((data) => {
      // Lecture O(1) via ref — pas de scan store à chaque frappe.
      if (isSyncRef.current) {
        const sess = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        if (sess) {
          for (const id of allPaneIds(sess.tree)) {
            const p = sess.panes[id];
            if (p?.kind === 'terminal') window.cmux.panes.write(p.id, data);
          }
          return;
        }
      }
      window.cmux.panes.write(pane.id, data);
    });

    if (settings.copyOnSelection) {
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) void window.cmux.clipboard.write(sel);
      });
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
  }, [visible, pane.id, settings]);

  // ResizeObserver debounced.
  useEffect(() => {
    if (!hostRef.current) return;
    let raf = 0;
    let lastCols = -1;
    let lastRows = -1;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term || !fit) return;
        try {
          fit.fit();
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
    ro.observe(hostRef.current);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [pane.id]);

  // Re-fit + focus quand on devient actif. On renvoie aussi un resize au PTY
  // pour que le main process sache que le renderer est prêt (déclenche le
  // bootLine de l'agent à la bonne taille, même après un restart).
  // On NE vole PAS le focus si l'utilisateur est dans un input/textarea
  // (e.g. dialog ouvert, address bar du preview, command palette…).
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    const f = fitRef.current;
    if (!t || !f) return;
    requestAnimationFrame(() => {
      try {
        f.fit();
        const ae = document.activeElement;
        const isFreeFocus =
          !ae || ae === document.body || (ae as HTMLElement).tagName === 'CANVAS';
        if (isFreeFocus) t.focus();
        window.cmux.panes.resize(pane.id, { cols: t.cols, rows: t.rows });
      } catch {
        /* ignore */
      }
    });
  }, [active, pane.id, pane.status]);

  // Live settings.
  useEffect(() => {
    const t = termRef.current;
    if (!t || !settings) return;
    t.options.fontFamily = settings.fontFamily;
    t.options.fontSize = settings.fontSize;
    t.options.cursorBlink = settings.cursorBlink;
    t.options.scrollback = settings.scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [settings?.fontFamily, settings?.fontSize, settings?.cursorBlink, settings?.scrollback]);

  // Cleanup au démontage.
  useEffect(() => {
    return () => {
      try {
        webglRef.current?.dispose();
      } catch {
        /* ignore */
      }
      try {
        termRef.current?.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      webglRef.current = null;
    };
  }, []);

  const onContextMenu = useCallback(
    async (e: MouseEvent): Promise<void> => {
      if (!settings?.pasteOnRightClick) return;
      e.preventDefault();
      const t = termRef.current;
      if (!t) return;
      const text = await window.cmux.clipboard.read();
      if (text) t.paste(text);
    },
    [settings?.pasteOnRightClick]
  );

  // Drag & drop : on récupère le chemin disque des fichiers déposés et on les
  // écrit dans le PTY (séparés par espace, avec quotes pour les chemins à espaces).
  const onDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const paths = files
        .map((f) => window.cmux.fs.pathForFile(f))
        .filter((p): p is string => !!p)
        .map((p) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p));
      if (paths.length === 0) return;
      const insert = paths.join(' ');
      window.cmux.panes.write(pane.id, insert);
      termRef.current?.focus();
    },
    [pane.id]
  );

  // Raccourcis pane-actif : Ctrl+Shift+F recherche, Ctrl+Shift+L clear scrollback.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        // Force clear même si l'agent ne supporte pas Ctrl+L lui-même.
        e.preventDefault();
        termRef.current?.clear();
      } else if (e.key === 'Escape' && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        termRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, searchOpen]);

  return (
    <div
      className={`terminal-pane ${active ? 'active' : ''} ${isSync ? 'sync' : ''}`}
      onClick={() => window.cmux.panes.focus(sessionId, pane.id)}
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
        <TerminalSearchBar
          searchAddon={searchRef.current}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

export const TerminalPane = memo(TerminalPaneImpl);

interface SearchBarProps {
  searchAddon: SearchAddon | null;
  onClose: () => void;
}

function TerminalSearchBar({ searchAddon, onClose }: SearchBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const findNext = useCallback(() => {
    if (query)
      searchAddon?.findNext(query, {
        decorations: {
          matchOverviewRuler: '#f97316',
          activeMatchColorOverviewRuler: '#fb923c'
        }
      });
  }, [query, searchAddon]);

  const findPrev = useCallback(() => {
    if (query)
      searchAddon?.findPrevious(query, {
        decorations: {
          matchOverviewRuler: '#f97316',
          activeMatchColorOverviewRuler: '#fb923c'
        }
      });
  }, [query, searchAddon]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) findPrev();
        else findNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [findNext, findPrev, onClose]
  );

  return (
    <div className="terminal-search">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Rechercher…"
      />
      <button className="btn-icon" onClick={findPrev} title="Précédent (Shift+Entrée)">
        <ChevronUp size={14} />
      </button>
      <button className="btn-icon" onClick={findNext} title="Suivant (Entrée)">
        <ChevronDown size={14} />
      </button>
      <button className="btn-icon" onClick={onClose} title="Fermer (Échap)">
        <XIcon size={14} />
      </button>
    </div>
  );
}
