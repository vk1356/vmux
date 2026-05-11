import { useCallback, useEffect, type CSSProperties, type JSX } from 'react';
import { TitleBar } from './components/TitleBar';
import { TabBar } from './components/TabBar';
import { UrlChips } from './components/UrlChips';
import { PaneTreeView } from './components/PaneTreeView';
import { ToastContainer } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useGlobalIpcSubscriptions } from './hooks/useGlobalIpcSubscriptions';
import { useSessionStore } from './store/sessions';

interface Props {
  sessionId: string;
}

// Constantes hoistées : pas re-créées à chaque render.
const SESSION_HOST_STYLE: CSSProperties = { display: 'flex' };
const noop = (): void => undefined;

/**
 * Vue minimaliste utilisée par les fenêtres Electron détachées (créées via
 * `window.cmux.window.detachSession(id)`). Pas de sidebar, pas de dialogs —
 * juste la TitleBar custom + la TabBar de la session + le PaneTreeView.
 *
 * Les fenêtres détachées partagent le même process main (single-instance) et
 * reçoivent les events PTY broadcastés à toutes les BrowserWindows. La
 * fenêtre se ferme automatiquement si la session est supprimée.
 */
export function DetachedApp({ sessionId }: Props): JSX.Element {
  useGlobalIpcSubscriptions();
  // Selectors atomiques : Zustand 5 compare par référence stricte par défaut,
  // donc chaque selector ne re-render que sur change de SA slice — pas
  // besoin de useShallow ici.
  const session = useSessionStore((s) => s.sessionsById[sessionId]);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const sessionsLoaded = useSessionStore(
    (s) => s.sessions.length > 0 || s.settings !== null
  );

  // Le store du detached partage la même Zustand instance que la mainWindow
  // (logique : même renderer, deux process Electron différents). On force
  // `activeSessionId` sur la session détachée pour que les composants qui
  // s'appuient dessus (PaneTreeView pour focus pane events) fonctionnent.
  useEffect(() => {
    setActiveSession(sessionId);
  }, [sessionId, setActiveSession]);

  // Window title : sync avec le nom de la session pour que la barre des
  // tâches Windows / Mission Control macOS affiche un label utile. Dep
  // SEULEMENT sur session?.name : sinon chaque upsert (heartbeat pane, etc.)
  // re-trigger l'effet alors que le titre est identique.
  useEffect(() => {
    const suffix = session?.name ? ` — ${session.name}` : '';
    document.title = `vMux${suffix}`;
  }, [session?.name]);

  // Auto-close si la session a été supprimée. On attend que les sessions
  // soient chargées pour ne pas fermer la window pendant le boot (race où
  // sessionsList n'a pas encore répondu).
  useEffect(() => {
    if (!sessionsLoaded) return;
    if (session) return;
    // Petit délai pour absorber les races (e.g. session renamed → upsert
    // momentanément différent). Si toujours absente après 1.5s : close.
    const t = setTimeout(() => {
      const cur = useSessionStore.getState().sessionsById[sessionId];
      if (!cur) void window.cmux.window.close();
    }, 1500);
    return (): void => clearTimeout(t);
  }, [session, sessionsLoaded, sessionId]);

  // Handler stable pour limiter les re-renders de PaneTreeView (memo).
  const onShowShortcuts = useCallback(noop, []);

  if (!session) {
    return (
      <div className="app detached">
        <TitleBar />
        <div className="detached-loading">Loading…</div>
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="app detached">
      <TitleBar />
      <main className="main">
        <div className="tab-bar">
          {/* onShowShortcuts est no-op : pas de palette de raccourcis dans le
              mode détaché (la fenêtre principale reste la source de vérité
              pour ces overlays). */}
          <TabBar session={session} onShowShortcuts={onShowShortcuts} detached />
          <UrlChips session={session} />
          <div className="tab-spacer" />
        </div>
        <div className="terminal-area">
          <div className="session-host" style={SESSION_HOST_STYLE}>
            {/* ErrorBoundary scope=pane : si le PaneTreeView crash, on garde
                la TitleBar + Toast et on offre un retry, sans tomber dans
                l'ErrorBoundary racine qui blank toute la window détachée. */}
            <ErrorBoundary scope="pane" label={session.name}>
              <PaneTreeView
                sessionId={session.id}
                tree={session.tree}
                panes={session.panes}
                activePaneId={session.activePaneId}
                visible={true}
              />
            </ErrorBoundary>
          </div>
        </div>
      </main>
      <ToastContainer />
    </div>
  );
}
