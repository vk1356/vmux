import { lazy, Suspense, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { TitleBar } from './components/TitleBar';
import { UpdateBanner } from './components/UpdateBanner';
import { Sidebar } from './components/Sidebar';
import { PaneTreeView } from './components/PaneTreeView';
import { EmptyState } from './components/EmptyState';
import { StatusBar } from './components/StatusBar';
import { ToastContainer, eventTitleFor } from './components/Toast';
import { UrlChips } from './components/UrlChips';
import { TabBar } from './components/TabBar';

// Lazy-load des dialogs : code split, ne sont chargés que quand l'utilisateur les ouvre.
const NewSessionDialog = lazy(() =>
  import('./components/NewSessionDialog').then((m) => ({ default: m.NewSessionDialog }))
);
const SettingsDialog = lazy(() =>
  import('./components/SettingsDialog').then((m) => ({ default: m.SettingsDialog }))
);
const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette }))
);
const ShortcutsOverlay = lazy(() =>
  import('./components/ShortcutsOverlay').then((m) => ({ default: m.ShortcutsOverlay }))
);
const NotificationCenter = lazy(() =>
  import('./components/NotificationCenter').then((m) => ({ default: m.NotificationCenter }))
);
const SnippetsPicker = lazy(() =>
  import('./components/SnippetsPicker').then((m) => ({ default: m.SnippetsPicker }))
);
const ConfirmDialog = lazy(() =>
  import('./components/ConfirmDialog').then((m) => ({ default: m.ConfirmDialog }))
);
import { useSessionStore } from './store/sessions';
import type { PaneAttention } from '@shared/types';
import { neighborInDirection } from '@shared/tree';
import { clamp, whenIdle } from '@shared/utils';

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;

export function App(): JSX.Element {
  const {
    sessions,
    activeSessionId,
    settings,
    setSessions,
    setAgents,
    setAgentAvailability,
    setSettings,
    upsertSession,
    removeSession,
    addToast,
    recordEvent,
    patchPane,
    toggleSync,
    bumpAttention,
    clearAttention,
    pushStatSamples
  } = useSessionStore();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Auto-collapse manuel par l'user — on ne ré-ouvre pas auto si l'user
  // a explicitement collapsé. On track ça pour ne forcer le collapse que
  // sur résize en dessous du seuil et ne pas le défaire ensuite.
  const userToggledSidebarRef = useRef(false);
  const [closeConfirm, setCloseConfirm] = useState<{ sessionId: string; name: string } | null>(
    null
  );
  const [sidebarPx, setSidebarPx] = useState<number>(DEFAULT_SIDEBAR);
  const draggingRef = useRef(false);

  // Bootstrap.
  useEffect(() => {
    void window.cmux.agents.list().then(setAgents);
    // agents.check spawn un process where.exe par agent — déféré à l'idle.
    whenIdle(() => void window.cmux.agents.check().then(setAgentAvailability));
    void window.cmux.settings.get().then((s) => {
      setSettings(s);
      const stored = typeof s.sidebarWidth === 'number' ? s.sidebarWidth : 22;
      const px = stored <= 100 ? Math.round((stored / 100) * window.innerWidth) : stored;
      setSidebarPx(clamp(px, MIN_SIDEBAR, MAX_SIDEBAR));
    });
    void window.cmux.sessions.list().then(setSessions);

    const offSession = window.cmux.sessions.onUpdate(upsertSession);
    const offStatus = window.cmux.panes.onStatus((sessionId, paneId, pane) => {
      patchPane(sessionId, paneId, pane);
    });
    const offUrls = window.cmux.panes.onUrls((paneId, urls) => {
      const state = useSessionStore.getState();
      const session = state.sessions.find((s) => paneId in s.panes);
      if (!session) return;
      const latest = urls[urls.length - 1];
      if (!latest) return;

      // Auto-open : si la session n'a pas encore de preview pane ET que le user
      // n'a pas explicitement fermé un preview, on ouvre.
      const hasPreview = Object.values(session.panes).some((p) => p.kind === 'preview');
      const wasDismissed = state.dismissedPreviewSessions.has(session.id);
      if (state.settings?.previewAutoOpen && !hasPreview && !wasDismissed) {
        void window.cmux.panes.openPreview(session.id, paneId, latest);
        return; // pas de toast nécessaire — le preview s'ouvre tout seul.
      }

      // Sinon : toast (l'utilisateur peut décider d'ouvrir manuellement).
      if (!state.settings?.previewToastEnabled) return;
      addToast({
        kind: 'url',
        title: 'URL localhost détectée',
        body: latest,
        url: latest,
        paneId,
        sessionId: session.id
      });
    });
    const offAttention = window.cmux.panes.onAttention((paneId, level) => {
      bumpAttention(paneId, level);
    });
    const offStats = window.cmux.panes.onStats(pushStatSamples);
    const offEvents = window.cmux.panes.onEvent((event) => {
      const state = useSessionStore.getState();
      const session = state.sessions.find((s) => event.paneId in s.panes);
      if (!session) return;
      recordEvent(session.id, event);
      addToast({
        kind: 'event',
        title: eventTitleFor(event.kind),
        body: event.message,
        paneId: event.paneId,
        sessionId: session.id
      });
    });
    // Map événements détectés → escalade attention :
    //   build-error → needs-input (bloquant)
    //   agent-done / build-success / server-ready → alert
    const offEvents2 = window.cmux.panes.onEvent((event) => {
      const level: PaneAttention =
        event.kind === 'build-error' ? 'needs-input' : 'alert';
      bumpAttention(event.paneId, level);
    });
    return () => {
      offSession();
      offStatus();
      offUrls();
      offStats();
      offEvents();
      offAttention();
      offEvents2();
    };
  }, [
    setSessions,
    setAgents,
    setAgentAvailability,
    setSettings,
    upsertSession,
    addToast,
    recordEvent,
    patchPane,
    bumpAttention,
    pushStatSamples
  ]);

  // Clear l'attention quand le pane actif **change** (pas à chaque heartbeat).
  const prevActivePaneRef = useRef<string | null>(null);
  useEffect(() => {
    const sess = sessions.find((s) => s.id === activeSessionId);
    const newActive = sess?.activePaneId ?? null;
    if (newActive && newActive !== prevActivePaneRef.current) {
      clearAttention(newActive);
      prevActivePaneRef.current = newActive;
    } else if (!newActive) {
      prevActivePaneRef.current = null;
    }
  }, [activeSessionId, sessions, clearAttention]);

  // Auto-collapse sidebar quand la fenêtre est étroite (mobile-like).
  // On respecte un toggle manuel récent pour ne pas se battre avec l'user.
  useEffect(() => {
    const SIDEBAR_AUTO_THRESHOLD = 720;
    const onResize = (): void => {
      if (userToggledSidebarRef.current) return;
      const w = window.innerWidth;
      setSidebarCollapsed((cur) => {
        const shouldCollapse = w < SIDEBAR_AUTO_THRESHOLD;
        return shouldCollapse !== cur ? shouldCollapse : cur;
      });
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (newSessionOpen) void window.cmux.agents.check().then(setAgentAvailability);
  }, [newSessionOpen, setAgentAvailability]);

  // Raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey;
      const session = sessions.find((s) => s.id === activeSessionId);
      const activePaneId = session?.activePaneId;

      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setNewSessionOpen(true);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (ctrl && !e.shiftKey && e.key === '/') {
        e.preventDefault();
        setSnippetsOpen(true);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'b') {
        // Toggle sidebar (style VS Code).
        e.preventDefault();
        userToggledSidebarRef.current = true;
        setSidebarCollapsed((c) => !c);
      } else if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        // Ctrl+1..9 → switche à la Nème session.
        const idx = parseInt(e.key, 10) - 1;
        if (sessions[idx]) {
          e.preventDefault();
          useSessionStore.getState().setActiveSession(sessions[idx].id);
        }
      } else if (e.key === '?' && !ctrl && !newSessionOpen && !settingsOpen && !paletteOpen) {
        // ? = ouvrir l'overlay de raccourcis (uniquement si on n'est pas déjà dans un dialog ou un input)
        const ae = document.activeElement;
        const inInput =
          ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'CANVAS');
        if (!inInput) {
          e.preventDefault();
          setShortcutsOpen(true);
        }
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 's' && session) {
        e.preventDefault();
        toggleSync(session.id);
      } else if (ctrl && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'd' && session && activePaneId) {
        // "Add pane" — ajoute un terminal ET retile en grid 2D auto.
        e.preventDefault();
        void window.cmux.panes
          .split({
            sessionId: session.id,
            paneId: activePaneId,
            direction: 'horizontal'
          })
          .then(() => window.cmux.panes.relayout(session.id, 'tiled'));
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e' && session && activePaneId) {
        // Split vertical manuel (sans retile — pour layout custom)
        e.preventDefault();
        void window.cmux.panes.split({
          sessionId: session.id,
          paneId: activePaneId,
          direction: 'vertical'
        });
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'g' && session) {
        // Re-tile la session courante en grid auto.
        e.preventDefault();
        void window.cmux.panes.relayout(session.id, 'tiled');
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'w' && session && activePaneId) {
        // Ferme le pane actif
        e.preventDefault();
        void window.cmux.panes.close(session.id, activePaneId);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'w' && activeSessionId) {
        // Ferme la session entière — avec confirmation si un agent tourne.
        e.preventDefault();
        const sess = sessions.find((s) => s.id === activeSessionId);
        const hasRunning = sess
          ? Object.values(sess.panes).some(
              (p) => p.kind === 'terminal' && (p.status === 'running' || p.status === 'starting')
            )
          : false;
        if (hasRunning && sess) {
          setCloseConfirm({ sessionId: sess.id, name: sess.name });
        } else if (sess) {
          void window.cmux.sessions.remove(sess.id);
          removeSession(sess.id);
        }
      } else if (e.altKey && session && activePaneId) {
        const dir =
          e.key === 'ArrowLeft'
            ? 'left'
            : e.key === 'ArrowRight'
              ? 'right'
              : e.key === 'ArrowUp'
                ? 'up'
                : e.key === 'ArrowDown'
                  ? 'down'
                  : null;
        if (dir) {
          e.preventDefault();
          const target = neighborInDirection(session.tree, activePaneId, dir);
          if (target) void window.cmux.panes.focus(session.id, target);
        }
      } else if (e.key === 'Escape') {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (snippetsOpen) setSnippetsOpen(false);
        else if (notifsOpen) setNotifsOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (newSessionOpen) setNewSessionOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    sessions,
    activeSessionId,
    newSessionOpen,
    settingsOpen,
    paletteOpen,
    shortcutsOpen,
    notifsOpen,
    snippetsOpen,
    removeSession,
    toggleSync
  ]);

  // Sidebar drag.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      const px = clamp(e.clientX, MIN_SIDEBAR, MAX_SIDEBAR);
      setSidebarPx(px);
    };
    const onUp = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      const pct = Math.round((sidebarPx / window.innerWidth) * 100);
      void window.cmux.settings.set({ sidebarWidth: pct });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarPx]);

  const startDrag = useCallback((): void => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  // Handlers stables pour limiter les re-renders des composants memo (Sidebar, TabBar).
  const openNewSession = useCallback(() => setNewSessionOpen(true), []);
  const closeNewSession = useCallback(() => setNewSessionOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const openNotifs = useCallback(() => setNotifsOpen(true), []);
  const closeNotifs = useCallback(() => setNotifsOpen(false), []);
  const openSnippets = useCallback(() => setSnippetsOpen(true), []);
  const closeSnippets = useCallback(() => setSnippetsOpen(false), []);

  const active = sessions.find((s) => s.id === activeSessionId);

  // Window title dynamique : Electron synchronise document.title → titre natif.
  useEffect(() => {
    const suffix = active ? ` — ${active.name}${active.branch ? ` · ${active.branch}` : ''}` : '';
    document.title = `vMux${suffix}`;
  }, [active?.id, active?.name, active?.branch]);

  return (
    <div className="app">
      <TitleBar />
      <UpdateBanner />

      <div
        className={`app-body ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{
          gridTemplateColumns: sidebarCollapsed ? '0 0 1fr' : `${sidebarPx}px 1px 1fr`
        }}
      >
        <Sidebar onNewSession={openNewSession} onOpenSettings={openSettings} />

        <div className="resize-handle" onMouseDown={startDrag} aria-hidden />

        <main className="main">
          {active && (
            <div className="tab-bar">
              <TabBar session={active} onShowShortcuts={openShortcuts} />
              <UrlChips session={active} />
              <div className="tab-spacer" />
              <div className="tab-shortcuts">
                <span className="kbd-inline">Ctrl+Shift+D</span> + pane
                <span className="kbd-inline">Ctrl+G</span> tile
                <span className="kbd-inline">Alt+←→↑↓</span> nav
              </div>
            </div>
          )}

          <div className="terminal-area">
            {sessions.length === 0 ? (
              <EmptyState onNewSession={openNewSession} />
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="session-host"
                  style={{ display: s.id === activeSessionId ? 'flex' : 'none' }}
                >
                  <PaneTreeView
                    sessionId={s.id}
                    tree={s.tree}
                    panes={s.panes}
                    activePaneId={s.activePaneId}
                    visible={s.id === activeSessionId}
                  />
                </div>
              ))
            )}
          </div>
        </main>
      </div>

      <StatusBar onOpenNotifications={openNotifs} />
      <ToastContainer />
      <Suspense fallback={null}>
        {newSessionOpen && (
          <NewSessionDialog open={newSessionOpen} onClose={closeNewSession} />
        )}
        {settingsOpen && <SettingsDialog open={settingsOpen} onClose={closeSettings} />}
        {paletteOpen && (
          <CommandPalette
            open={paletteOpen}
            onClose={closePalette}
            onNewSession={openNewSession}
            onOpenSettings={openSettings}
          />
        )}
        {shortcutsOpen && <ShortcutsOverlay open={shortcutsOpen} onClose={closeShortcuts} />}
        {notifsOpen && <NotificationCenter open={notifsOpen} onClose={closeNotifs} />}
        {snippetsOpen && (
          <SnippetsPicker open={snippetsOpen} session={active ?? null} onClose={closeSnippets} />
        )}
        {closeConfirm && (
          <ConfirmDialog
            open
            danger
            title="Fermer la session"
            message={`La session « ${closeConfirm.name} » a un agent en cours. Toutes les exécutions seront tuées. Continuer ?`}
            confirmLabel="Fermer la session"
            onCancel={() => setCloseConfirm(null)}
            onConfirm={() => {
              void window.cmux.sessions.remove(closeConfirm.sessionId);
              removeSession(closeConfirm.sessionId);
              setCloseConfirm(null);
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
