import { useEffect, type JSX } from 'react';
import { TitleBar } from './components/TitleBar';
import { TabBar } from './components/TabBar';
import { UrlChips } from './components/UrlChips';
import { PaneTreeView } from './components/PaneTreeView';
import { ToastContainer } from './components/Toast';
import { useGlobalIpcSubscriptions } from './hooks/useGlobalIpcSubscriptions';
import { useSessionStore } from './store/sessions';

interface Props {
  sessionId: string;
}

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
  const session = useSessionStore((s) => s.sessionsById[sessionId]);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const sessionsLoaded = useSessionStore((s) => s.sessions.length > 0 || s.settings !== null);

  // Le store du detached partage la même Zustand instance que la mainWindow
  // (logique : même renderer, deux process Electron différents). On force
  // `activeSessionId` sur la session détachée pour que les composants qui
  // s'appuient dessus (PaneTreeView pour focus pane events) fonctionnent.
  useEffect(() => {
    setActiveSession(sessionId);
  }, [sessionId, setActiveSession]);

  // Window title : sync avec le nom de la session pour que la barre des
  // tâches Windows / Mission Control macOS affiche un label utile.
  useEffect(() => {
    const suffix = session ? ` — ${session.name}` : '';
    document.title = `vMux${suffix}`;
  }, [session?.name, session]);

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
          <TabBar session={session} onShowShortcuts={() => undefined} detached />
          <UrlChips session={session} />
          <div className="tab-spacer" />
        </div>
        <div className="terminal-area">
          <div className="session-host" style={{ display: 'flex' }}>
            <PaneTreeView
              sessionId={session.id}
              tree={session.tree}
              panes={session.panes}
              activePaneId={session.activePaneId}
              visible={true}
            />
          </div>
        </div>
      </main>
      <ToastContainer />
    </div>
  );
}
