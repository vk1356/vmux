import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type JSX
} from 'react';
import { TitleBar } from './components/TitleBar';
import { UpdateBanner } from './components/UpdateBanner';
import { Sidebar } from './components/Sidebar';
import { PaneTreeView } from './components/PaneTreeView';
import { EmptyState } from './components/EmptyState';
import { StatusBar } from './components/StatusBar';
import { ToastContainer } from './components/Toast';
import { UrlChips } from './components/UrlChips';
import { TabBar } from './components/TabBar';
import { OnboardingOverlay } from './components/OnboardingOverlay';

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
const McpManagerDialog = lazy(() =>
  import('./components/McpManagerDialog').then((m) => ({ default: m.McpManagerDialog }))
);
import { useSessionStore } from './store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { clamp } from '@shared/utils';
import { useGlobalIpcSubscriptions } from './hooks/useGlobalIpcSubscriptions';
import { useResizableSidebar } from './hooks/useResizableSidebar';
import { useFolderDragDrop } from './hooks/useFolderDragDrop';
import { useGlobalKeybindings } from './hooks/useGlobalKeybindings';

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;
const SIDEBAR_AUTO_THRESHOLD = 720;

export function App(): JSX.Element {
  // useShallow : on ne re-render que si une des clés sélectionnées change.
  const { sessions, activeSessionId, settings, setAgentAvailability, removeSession, clearAttention } =
    useSessionStore(
      useShallow((s) => ({
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
        settings: s.settings,
        setAgentAvailability: s.setAgentAvailability,
        removeSession: s.removeSession,
        clearAttention: s.clearAttention
      }))
    );

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  /** Cwd transmis à NewSessionDialog quand on ouvre via drag-drop d'un dossier. */
  const [newSessionDefaultCwd, setNewSessionDefaultCwd] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState<{ sessionId: string; name: string } | null>(
    null
  );
  // Onboarding : affiché tant que settings.onboardingCompleted !== true. On
  // attend que les settings soient chargés (settings === null au boot) pour
  // éviter un flash de l'overlay si l'user a déjà skip. Un ref garantit qu'on
  // n'ouvre l'overlay qu'une seule fois (sinon close → settings update → re-open).
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const onboardingShownRef = useRef(false);
  useEffect(() => {
    if (onboardingShownRef.current || !settings) return;
    onboardingShownRef.current = true;
    if (settings.onboardingCompleted !== true) setOnboardingOpen(true);
  }, [settings]);
  const closeOnboarding = useCallback((completed: boolean): void => {
    setOnboardingOpen(false);
    void window.cmux.settings.set({ onboardingCompleted: true });
    void completed; // skip vs finish : même résultat persisté ; on ne re-affiche jamais.
  }, []);

  const persistRatio = useCallback((pct: number) => {
    void window.cmux.settings.set({ sidebarWidth: pct });
  }, []);
  const sidebar = useResizableSidebar({
    min: MIN_SIDEBAR,
    max: MAX_SIDEBAR,
    initial: DEFAULT_SIDEBAR,
    autoCollapseThreshold: SIDEBAR_AUTO_THRESHOLD,
    onPersistRatio: persistRatio
  });

  // Init de la largeur de sidebar depuis les settings persistés.
  const sidebarInitedRef = useRef(false);
  useEffect(() => {
    if (sidebarInitedRef.current || !settings) return;
    sidebarInitedRef.current = true;
    const stored = typeof settings.sidebarWidth === 'number' ? settings.sidebarWidth : 22;
    const px =
      stored <= 100 ? Math.round((stored / 100) * window.innerWidth) : stored;
    sidebar.setWidthPx(clamp(px, MIN_SIDEBAR, MAX_SIDEBAR));
  }, [settings, sidebar]);

  // Toutes les souscriptions IPC + bootstrap initial — extrait dans un hook.
  useGlobalIpcSubscriptions();

  // Drag-drop d'un dossier sur la window → ouvre New Session.
  const onFolderDropped = useCallback((p: string) => {
    setNewSessionDefaultCwd(p);
    setNewSessionOpen(true);
  }, []);
  useFolderDragDrop(onFolderDropped);

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

  // agents.check spawn un process where.exe par agent : on l'évite si le dialog
  // se ferme. AbortController garantit qu'un check en vol ne pousse pas son
  // résultat dans le store après que le dialog se soit refermé.
  useEffect(() => {
    if (!newSessionOpen) return;
    const ac = new AbortController();
    void window.cmux.agents.check().then((r) => {
      if (!ac.signal.aborted) setAgentAvailability(r);
    });
    return (): void => ac.abort();
  }, [newSessionOpen, setAgentAvailability]);

  // Raccourcis clavier globaux — extrait dans useGlobalKeybindings.
  useGlobalKeybindings({
    sessions,
    activeSessionId,
    dialogs: {
      newSessionOpen,
      settingsOpen,
      paletteOpen,
      shortcutsOpen,
      notifsOpen,
      snippetsOpen,
      closeConfirmOpen: closeConfirm !== null,
      onboardingOpen
    },
    actions: {
      setNewSessionOpen,
      setSettingsOpen,
      setPaletteOpen,
      setShortcutsOpen,
      setNotifsOpen,
      setSnippetsOpen,
      setCloseConfirm,
      toggleSidebar: sidebar.toggleCollapsed
    }
  });

  // useTransition : ouvrir un dialog lazy déclenche le chargement d'un chunk
  // + suspense fallback. On marque ces updates comme non-urgents pour ne pas
  // bloquer le clic dans l'UI (React 19 garde la frame réactive pendant le load).
  const [, startDialogTransition] = useTransition();

  // Handlers stables pour limiter les re-renders des composants memo (Sidebar, TabBar).
  const openNewSession = useCallback(() => {
    setNewSessionDefaultCwd(undefined);
    startDialogTransition(() => setNewSessionOpen(true));
  }, []);
  const closeNewSession = useCallback(() => {
    setNewSessionOpen(false);
    setNewSessionDefaultCwd(undefined);
  }, []);
  const openSettings = useCallback(() => startDialogTransition(() => setSettingsOpen(true)), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openShortcuts = useCallback(() => startDialogTransition(() => setShortcutsOpen(true)), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const openNotifs = useCallback(() => startDialogTransition(() => setNotifsOpen(true)), []);
  const closeNotifs = useCallback(() => setNotifsOpen(false), []);
  const closeSnippets = useCallback(() => setSnippetsOpen(false), []);
  const openMcp = useCallback(() => startDialogTransition(() => setMcpOpen(true)), []);
  const closeMcp = useCallback(() => setMcpOpen(false), []);
  const cancelCloseConfirm = useCallback(() => setCloseConfirm(null), []);
  const confirmCloseSession = useCallback(() => {
    setCloseConfirm((cur) => {
      if (!cur) return null;
      void window.cmux.sessions.remove(cur.sessionId);
      removeSession(cur.sessionId);
      return null;
    });
  }, [removeSession]);

  // sessions est un array stable par référence sous useShallow tant qu'aucune
  // session change, mais .find recomputerait quand même : on memo pour stabiliser
  // les props passées à TabBar/SnippetsPicker.
  const active = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  // Window title dynamique : Electron synchronise document.title → titre natif.
  useEffect(() => {
    const suffix = active ? ` — ${active.name}${active.branch ? ` · ${active.branch}` : ''}` : '';
    document.title = `vMux${suffix}`;
    // On dépend des champs scalaires, PAS de la ref `active` : le store rend un
    // nouvel objet Session à chaque bump paneStatus (sortie d'agent), donc
    // dépendre de `active` réécrirait le titre à chaque chunk d'output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.name, active?.branch]);

  // Style inline du grid sidebar — memo pour éviter une nouvelle ref à chaque
  // render (sinon le div parent invalide ses children stylesheet diff).
  const bodyGridStyle = useMemo<CSSProperties>(
    () => ({
      gridTemplateColumns: sidebar.collapsed ? '0 0 1fr' : `${sidebar.widthPx}px 1px 1fr`
    }),
    [sidebar.collapsed, sidebar.widthPx]
  );

  return (
    <div className="app">
      <TitleBar />
      <UpdateBanner />

      <div
        className={`app-body ${sidebar.collapsed ? 'sidebar-collapsed' : ''}`}
        style={bodyGridStyle}
      >
        <Sidebar onNewSession={openNewSession} onOpenSettings={openSettings} />

        <div className="resize-handle" onMouseDown={sidebar.startDrag} aria-hidden />

        <main className="main">
          {active && (
            <div className="tab-bar">
              <TabBar session={active} onShowShortcuts={openShortcuts} />
              <UrlChips session={active} />
              <div className="tab-spacer" />
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
      <OnboardingOverlay open={onboardingOpen} onClose={closeOnboarding} />
      <Suspense fallback={null}>
        {newSessionOpen && (
          <NewSessionDialog
            open={newSessionOpen}
            onClose={closeNewSession}
            defaultCwd={newSessionDefaultCwd}
          />
        )}
        {settingsOpen && <SettingsDialog open={settingsOpen} onClose={closeSettings} />}
        {paletteOpen && (
          <CommandPalette
            open={paletteOpen}
            onClose={closePalette}
            onNewSession={openNewSession}
            onOpenSettings={openSettings}
            onOpenMcp={openMcp}
          />
        )}
        {mcpOpen && <McpManagerDialog open={mcpOpen} onClose={closeMcp} />}
        {shortcutsOpen && <ShortcutsOverlay open={shortcutsOpen} onClose={closeShortcuts} />}
        {notifsOpen && <NotificationCenter open={notifsOpen} onClose={closeNotifs} />}
        {snippetsOpen && (
          <SnippetsPicker open={snippetsOpen} session={active} onClose={closeSnippets} />
        )}
        {closeConfirm && (
          <ConfirmDialog
            open
            danger
            title="Fermer la session"
            message={`La session « ${closeConfirm.name} » a un agent en cours. Toutes les exécutions seront tuées. Continuer ?`}
            confirmLabel="Fermer la session"
            onCancel={cancelCloseConfirm}
            onConfirm={confirmCloseSession}
          />
        )}
      </Suspense>
    </div>
  );
}
