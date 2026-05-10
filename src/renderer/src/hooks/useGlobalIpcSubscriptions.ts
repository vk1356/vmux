import { useEffect } from 'react';
import { useSessionStore } from '../store/sessions';
import { translate } from '../i18n';
import { eventTitleFor } from '../components/Toast';
import type { PaneAttention } from '@shared/types';

/**
 * Bootstrap de toutes les souscriptions IPC globales du renderer + chargement
 * initial agents/settings/sessions. Extrait d'App.tsx pour cloisonner ~120
 * lignes de plomberie.
 *
 * Tous les handlers ressuscitent l'état via useSessionStore.getState() pour
 * éviter les closures stales — l'effet ne se ré-attache jamais après mount.
 */
export function useGlobalIpcSubscriptions(): void {
  const setSessions = useSessionStore((s) => s.setSessions);
  const setAgents = useSessionStore((s) => s.setAgents);
  const setAgentAvailability = useSessionStore((s) => s.setAgentAvailability);
  const setSettings = useSessionStore((s) => s.setSettings);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const addToast = useSessionStore((s) => s.addToast);
  const recordEvent = useSessionStore((s) => s.recordEvent);
  const patchPane = useSessionStore((s) => s.patchPane);
  const bumpAttention = useSessionStore((s) => s.bumpAttention);
  const setAgentState = useSessionStore((s) => s.setAgentState);
  const pushStatSamples = useSessionStore((s) => s.pushStatSamples);
  const pushSystemStats = useSessionStore((s) => s.pushSystemStats);

  useEffect(() => {
    void window.cmux.agents.list().then(setAgents);
    // agents.check spawn un process where.exe par agent — déféré à l'idle.
    import('@shared/utils').then(({ whenIdle }) =>
      whenIdle(() => void window.cmux.agents.check().then(setAgentAvailability))
    );
    void window.cmux.settings.get().then(setSettings);
    void window.cmux.sessions.list().then(setSessions);

    const offSession = window.cmux.sessions.onUpdate(upsertSession);
    const offStatus = window.cmux.panes.onStatus((sessionId, paneId, pane) => {
      patchPane(sessionId, paneId, pane);
    });
    const offUrls = window.cmux.panes.onUrls((paneId, urls) => {
      // NB : on n'auto-ouvre PLUS de preview ici. Une URL détectée dans le PTY
      // peut venir d'une simple réponse de l'agent. L'auto-open n'est déclenché
      // QUE par l'event 'server-ready' (ci-dessous).
      const state = useSessionStore.getState();
      const session = state.sessions.find((s) => paneId in s.panes);
      if (!session) return;
      const latest = urls[urls.length - 1];
      if (!latest) return;
      if (!state.settings?.previewToastEnabled) return;
      const lang = state.settings?.language ?? 'en';
      addToast({
        kind: 'url',
        title: translate(lang, 'urlDetectedLabel'),
        body: latest,
        url: latest,
        paneId,
        sessionId: session.id
      });
    });
    const offAttention = window.cmux.panes.onAttention((paneId, level) => {
      bumpAttention(paneId, level);
    });
    const offAgentState = window.cmux.panes.onAgentState((paneId, state) => {
      setAgentState(paneId, state);
    });
    const offStats = window.cmux.panes.onStats(pushStatSamples);
    const offSystemStats = window.cmux.panes.onSystemStats(pushSystemStats);
    // Single handler — précédemment 2 abonnements distincts (onEvent x2)
    // créaient un doublon : chaque event était traité 2 fois et bumpAttention
    // pouvait flasher le badge. On centralise ici toast + attention + auto-open
    // preview (uniquement sur server-ready, pas sur toute URL détectée).
    const offEvents = window.cmux.panes.onEvent((event) => {
      const state = useSessionStore.getState();
      const session = state.sessions.find((s) => event.paneId in s.panes);
      if (!session) return;
      recordEvent(session.id, event);
      const lang = state.settings?.language ?? 'en';
      // Pour les events `notify` (OSC), l'agent fournit son propre titre via
      // event.title — on l'utilise tel quel plutôt que le label i18n hardcodé.
      const toastTitle =
        event.kind === 'notify' && event.title
          ? `🔔 ${event.title}`
          : eventTitleFor(event.kind, lang);
      addToast({
        kind: 'event',
        title: toastTitle,
        body: event.message,
        paneId: event.paneId,
        sessionId: session.id,
        eventKind: event.kind
      });
      // Escalade attention : build-error → needs-input (bloquant), sinon alert.
      const level: PaneAttention = event.kind === 'build-error' ? 'needs-input' : 'alert';
      bumpAttention(event.paneId, level);

      // Auto-open du preview : UNIQUEMENT si l'event est un vrai démarrage de
      // serveur. event.url est extrait de la ligne matchée ; sinon on retombe
      // sur la dernière URL localhost détectée par le pane (recentUrls).
      if (event.kind !== 'server-ready') return;
      if (!state.settings?.previewAutoOpen) return;
      const hasPreview = Object.values(session.panes).some((p) => p.kind === 'preview');
      if (hasPreview) return;
      if (state.dismissedPreviewSessions.has(session.id)) return;
      const pane = session.panes[event.paneId];
      const fallbackUrl =
        pane?.kind === 'terminal' && pane.recentUrls?.length
          ? pane.recentUrls[pane.recentUrls.length - 1]
          : undefined;
      const url = event.url ?? fallbackUrl;
      if (!url) return;
      void window.cmux.panes.openPreview(session.id, event.paneId, url);
    });
    // Focus request émis par le main (clic sur une notif système). On switche
    // activeSessionId via le store, puis on focus le pane via IPC. Sans ça,
    // l'user atterrit sur la session active courante et pas celle qui a crié
    // — UX inacceptable en multi-agent.
    const offFocusRequest = window.cmux.sessions.onFocusRequest((sessionId, paneId) => {
      useSessionStore.getState().setActiveSession(sessionId);
      void window.cmux.panes.focus(sessionId, paneId);
    });
    // Custom notification sound — main demande au renderer de jouer un .wav/.mp3.
    const offNotifSound = window.cmux.notif.onPlaySound((path) => {
      try {
        const url = path.startsWith('file:') ? path : `file:///${path.replace(/\\/g, '/')}`;
        const audio = new Audio(url);
        audio.volume = 0.7;
        void audio.play().catch(() => {
          /* ignore — fichier introuvable / format non supporté */
        });
      } catch {
        /* ignore */
      }
    });
    return () => {
      offSession();
      offStatus();
      offUrls();
      offStats();
      offSystemStats();
      offEvents();
      offAttention();
      offAgentState();
      offFocusRequest();
      offNotifSound();
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
    setAgentState,
    pushStatSamples,
    pushSystemStats
  ]);
}
