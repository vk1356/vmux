import { useEffect } from 'react';
import { useSessionStore } from '../store/sessions';
import { translate } from '../i18n';
import { eventTitleFor } from '../i18n/eventTitle';
import { whenIdle } from '@shared/utils';
import type { PaneAttention } from '@shared/types';

/**
 * Bootstrap de toutes les souscriptions IPC globales du renderer + chargement
 * initial agents/settings/sessions. Extrait d'App.tsx pour cloisonner ~120
 * lignes de plomberie.
 *
 * Tous les handlers ressuscitent l'état via useSessionStore.getState() pour
 * éviter les closures stales — l'effet ne se ré-attache jamais après mount.
 *
 * AbortSignal garde les promises de bootstrap (settings/sessions/agents) de
 * pousser leur résultat dans le store après unmount — important en dev
 * StrictMode (mount/cleanup/mount) et lors d'un refresh manuel HMR.
 */
export function useGlobalIpcSubscriptions(): void {
  useEffect(() => {
    // Read actions via getState() — Zustand 5 garantit que les actions sont
    // stables par référence pour la vie du store. Pas besoin de 13 subscriptions
    // (chacune coûte un selector run par store update), ni d'un dep-array qui
    // re-mount tout l'effet sous StrictMode et risque de doubler les listeners IPC.
    const {
      setSessions,
      setAgents,
      setAgentAvailability,
      setSettings,
      setActiveSession,
      upsertSession,
      addToast,
      recordEvent,
      patchPane,
      bumpAttention,
      setAgentState,
      pushStatSamples,
      pushSystemStats
    } = useSessionStore.getState();

    const ac = new AbortController();
    const { signal } = ac;

    void window.cmux.agents.list().then((r) => {
      if (!signal.aborted) setAgents(r);
    });
    // agents.check spawn un process where.exe par agent — déféré à l'idle.
    // (whenIdle est importé statiquement : utils.ts est déjà dans le bundle
    // principal via App.tsx & co, donc l'ancien import() dynamique était
    // inefficace — build warning INEFFECTIVE_DYNAMIC_IMPORT — sans rien différer.)
    whenIdle(() => {
      if (signal.aborted) return;
      void window.cmux.agents.check().then((r) => {
        if (!signal.aborted) setAgentAvailability(r);
      });
    });
    // Boot : settings et sessions sont indépendants côté main — on les fetch
    // en parallèle pour économiser un round-trip IPC. L'ordre d'application
    // côté store reste settings → activeSession seed → sessions, car
    // setSessions a une logique de fallback ("garde l'active si valide, sinon
    // sessions[0]") qui doit voir un activeSessionId déjà seedé.
    void Promise.all([window.cmux.settings.get(), window.cmux.sessions.list()]).then(
      ([s, sessions]) => {
        if (signal.aborted) return;
        setSettings(s);
        if (s.lastActiveSessionId) {
          setActiveSession(s.lastActiveSessionId);
        }
        setSessions(sessions);
      }
    );

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
    // On garde une ref sur l'élément Audio courant pour pouvoir l'arrêter à
    // l'unmount (évite un son qui continue après refresh HMR).
    let currentAudio: HTMLAudioElement | null = null;
    const offNotifSound = window.cmux.notif.onPlaySound((path) => {
      if (signal.aborted) return;
      try {
        const url = path.startsWith('file:') ? path : `file:///${path.replace(/\\/g, '/')}`;
        const audio = new Audio(url);
        audio.volume = 0.7;
        currentAudio = audio;
        void audio.play().catch(() => {
          /* ignore — fichier introuvable / format non supporté */
        });
      } catch {
        /* ignore */
      }
    });
    // Persist activeSessionId à chaque changement — utilisé au boot pour
    // restaurer la dernière session ouverte. Subscribe via zustand.subscribe
    // (sans re-render) ; debounce 400ms pour éviter de marteler le disque sur
    // un drag rapide entre sessions.
    // SKIP dans les fenêtres détachées : leur "activeSessionId" est forcé à
    // la session détachée et n'a pas de sens à persister — sinon ça écrase
    // ce que la fenêtre principale persiste, race fâcheuse au switch rapide.
    const isDetached = window.location.hash.startsWith('#detached=');
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPersisted: string | null = null;
    const offActiveSubscribe = isDetached
      ? (): void => {}
      : useSessionStore.subscribe((state, prev) => {
          if (state.activeSessionId === prev.activeSessionId) return;
          if (state.activeSessionId === lastPersisted) return;
          if (persistTimer) clearTimeout(persistTimer);
          persistTimer = setTimeout(() => {
            persistTimer = null;
            const id = useSessionStore.getState().activeSessionId;
            if (id === lastPersisted) return;
            lastPersisted = id;
            void window.cmux.settings.set({ lastActiveSessionId: id });
          }, 400);
        });
    return () => {
      ac.abort();
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
      offActiveSubscribe();
      if (persistTimer) clearTimeout(persistTimer);
      if (currentAudio) {
        try {
          currentAudio.pause();
          currentAudio.src = '';
        } catch {
          /* ignore */
        }
        currentAudio = null;
      }
    };
    // Mount-once effect : toutes les actions sont lues via getState() (refs
    // stables Zustand 5). Aucun re-mount à craindre — sauf StrictMode dev qui
    // exécute mount/cleanup/mount à dessein, ce qui est désormais propre.
  }, []);
}
