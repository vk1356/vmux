import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { uuid } from '@shared/utils';
import { clearPaneData } from './paneDataBus';
import type {
  AgentAvailability,
  AgentPreset,
  AgentRunState,
  AppSettings,
  DetectedEvent,
  DetectedEventKind,
  PaneAttention,
  PaneId,
  PaneStatSample,
  Session,
  SystemStatsSample,
  TerminalPane
} from '@shared/types';

/** Capacité de la fenêtre glissante d'historique (samples par pane).
 *  Poll = 2s → 150 samples = 5 minutes. Donne assez de recul pour repérer
 *  une fuite mémoire ou un agent qui ralentit, vs l'ancien 30s qui ne
 *  permettait que de voir l'instant présent. */
export const STATS_WINDOW = 150;

/** Cap dur sur l'historique d'events détectés (push/shift en tête). */
export const EVENT_HISTORY_CAP = 200;

export interface PaneStatsHistory {
  /** CPU% — fenêtre circulaire ; ordre chronologique (plus ancien en [0]).
   *  Stocké en raw pidusage (0..100*cores) ; l'UI normalise selon le mode. */
  cpu: Float32Array;
  /** RAM en octets — même fenêtre. */
  memory: Float32Array;
  /** Nombre de cœurs logiques de la machine — copié depuis le sample, sert
   *  à l'UI pour normaliser CPU% en % machine. Constant durant la session. */
  cores: number;
  /** True dès que pidusage a renvoyé un delta valide pour ce pane (≥ 2 polls).
   *  Avant : l'UI affiche "calculating…" pour ne pas mentir avec un faux 0%. */
  primed: boolean;
  /** Dernière valeur reçue (pratique pour l'affichage instantané). */
  last: { cpu: number; memory: number; timestamp: number } | null;
}

export interface ToastItem {
  id: string;
  kind: 'url' | 'event';
  title: string;
  body?: string;
  /** URL pour les toasts d'URL détectée. */
  url?: string;
  /** Pane terminal qui a généré le toast. */
  paneId?: PaneId;
  sessionId?: string;
  /** Type d'event détecté — utilisé pour choisir l'icône sans inférer via le texte traduit. */
  eventKind?: DetectedEventKind;
  ts: number;
}

export interface EventHistoryEntry {
  event: DetectedEvent;
  sessionId: string;
  sessionName: string;
  readAt?: number;
}

interface SessionStore {
  sessions: Session[];
  /** Index dérivé sessionId → Session — maintenu en parallèle de `sessions`.
   *  Évite les `.find()` O(N) répétés dans App.tsx, Sidebar, PreviewPane. */
  sessionsById: Record<string, Session>;
  agents: AgentPreset[];
  agentAvailability: Record<string, AgentAvailability>;
  settings: AppSettings | null;
  activeSessionId: string | null;
  /** Sessions où le sync-input est activé (Ctrl+Shift+S). */
  syncSessions: Set<string>;
  /** Sessions où l'utilisateur a explicitement fermé un preview pane —
   *  on n'auto-ouvre plus de preview tant qu'il n'en lance pas un manuellement. */
  dismissedPreviewSessions: Set<string>;
  /** Derniers events par session (pour badges sidebar). */
  lastEventBySession: Record<string, DetectedEvent>;
  toasts: ToastItem[];
  /** Historique des events détectés (cap EVENT_HISTORY_CAP) — utilisé par le NotificationCenter. */
  eventHistory: EventHistoryEntry[];
  /** Niveau d'attention par pane — `idle` quand le user a focus, sinon escalade. */
  paneActivity: Record<PaneId, PaneAttention>;
  /** État live de l'agent IA par pane (idle/thinking/generating/needs-input).
   *  Orthogonal à paneActivity (qui est un signal d'attention non-lu, persistant).
   *  paneAgentState reflète l'état courant et bascule en idle dès que le PTY se calme. */
  paneAgentState: Record<PaneId, AgentRunState>;
  /** Historique CPU/RAM par pane (fenêtre glissante de STATS_WINDOW samples). */
  paneStats: Record<PaneId, PaneStatsHistory>;
  /** Stats globales machine + somme vMux (push toutes les 2s depuis main).
   *  null tant qu'aucun pane n'a démarré (pty-stats ne tourne qu'avec ≥1 pane). */
  systemStats: SystemStatsSample | null;
  /** Historique des CPU% machine (fenêtre glissante) — alimenté en parallèle
   *  pour la mini-sparkline système dans la status bar. */
  systemCpuHistory: Float32Array;

  setSessions: (s: Session[]) => void;
  setAgents: (a: AgentPreset[]) => void;
  setAgentAvailability: (a: AgentAvailability[]) => void;
  setSettings: (s: AppSettings) => void;
  patchSettings: (p: Partial<AppSettings>) => void;
  setActiveSession: (id: string | null) => void;
  reorderSessions: (sourceId: string, targetId: string) => void;
  toggleSync: (id: string) => void;
  dismissPreview: (sessionId: string) => void;
  resetPreviewDismissal: (sessionId: string) => void;

  upsertSession: (s: Session) => void;
  removeSession: (id: string) => void;
  patchPane: (sessionId: string, paneId: PaneId, patch: Partial<TerminalPane>) => void;

  addToast: (t: Omit<ToastItem, 'id' | 'ts'> & { id?: string }) => void;
  removeToast: (id: string) => void;
  recordEvent: (sessionId: string, event: DetectedEvent) => void;
  markEventsRead: () => void;
  clearEventHistory: () => void;
  /** Bump l'attention sur un pane (max-merge avec valeur courante).
   *  No-op si le pane est l'active du focus actuel. */
  bumpAttention: (paneId: PaneId, level: PaneAttention) => void;
  /** Clear l'attention d'un pane (appelé quand le user focuses ce pane). */
  clearAttention: (paneId: PaneId) => void;
  /** Setter de l'état live d'agent — appelé sur chaque transition côté main. */
  setAgentState: (paneId: PaneId, state: AgentRunState) => void;
  /** Append samples CPU/RAM (push depuis le main toutes les 2s). */
  pushStatSamples: (samples: PaneStatSample[]) => void;
  /** Met à jour les stats système globales. */
  pushSystemStats: (sample: SystemStatsSample) => void;
}

/** Ordre d'escalade des niveaux d'attention. Exporté pour les composants qui
 *  doivent comparer des niveaux entre eux (sidebar agrégeant les panes). */
export type AttentionLevel = PaneAttention;
export const ATTENTION_RANK: Readonly<Record<AttentionLevel, number>> = {
  idle: 0,
  activity: 1,
  alert: 2,
  'needs-input': 3
};

/** Reconstruit l'index sessionsById depuis un array. */
function indexSessions(arr: readonly Session[]): Record<string, Session> {
  const idx: Record<string, Session> = {};
  for (const s of arr) idx[s.id] = s;
  return idx;
}

/** Purge auxiliaire — supprime les entrées par-paneId qui n'existent plus
 *  dans la session après un closePane. Évite une fuite progressive de
 *  paneStats / paneActivity / paneAgentState lors d'un churn intra-session. */
function purgePaneMaps<V>(
  map: Record<PaneId, V>,
  removedPaneIds: readonly PaneId[]
): { changed: boolean; next: Record<PaneId, V> } {
  let changed = false;
  let next = map;
  for (const pid of removedPaneIds) {
    if (pid in next) {
      if (!changed) {
        next = { ...map };
        changed = true;
      }
      delete next[pid];
    }
  }
  return { changed, next };
}

// Zustand v5 : la forme curried `create<T>()(...)` est requise pour bénéficier
// de l'inférence de types et rester compatible avec les middlewares (cf. docs
// Zustand v5 — migrating to v5). Pas de middleware ici : aucun consumer
// transient (toutes les lectures passent par useSessionStore en React) et
// devtools/persist ajouteraient bundle + cost runtime sans bénéfice.
export const useSessionStore = create<SessionStore>()((set) => ({
  sessions: [],
  sessionsById: {},
  agents: [],
  agentAvailability: {},
  settings: null,
  activeSessionId: null,
  syncSessions: new Set(),
  dismissedPreviewSessions: new Set(),
  lastEventBySession: {},
  toasts: [],
  eventHistory: [],
  paneActivity: {},
  paneAgentState: {},
  paneStats: {},
  systemStats: null,
  systemCpuHistory: new Float32Array(0),

  setSessions: (sessions) =>
    set((state) => ({
      sessions,
      sessionsById: indexSessions(sessions),
      activeSessionId:
        state.activeSessionId && sessions.some((s) => s.id === state.activeSessionId)
          ? state.activeSessionId
          : sessions[0]?.id ?? null
    })),

  setAgents: (agents) => set({ agents }),

  setAgentAvailability: (list) =>
    set({ agentAvailability: Object.fromEntries(list.map((a) => [a.id, a])) }),

  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) =>
    set((s) => ({ settings: s.settings ? { ...s.settings, ...patch } : null })),

  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  reorderSessions: (sourceId, targetId) =>
    set((state) => {
      if (sourceId === targetId) return {};
      const arr = [...state.sessions];
      const sIdx = arr.findIndex((s) => s.id === sourceId);
      const tIdx = arr.findIndex((s) => s.id === targetId);
      if (sIdx === -1 || tIdx === -1) return {};
      const [moved] = arr.splice(sIdx, 1);
      arr.splice(tIdx, 0, moved);
      // sessionsById n'est pas affecté par un reorder (mêmes refs).
      return { sessions: arr };
    }),

  toggleSync: (id) =>
    set((state) => {
      // Toggle est une vraie mutation par définition — on doit allouer un new Set.
      const next = new Set(state.syncSessions);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { syncSessions: next };
    }),

  dismissPreview: (sessionId) =>
    set((state) => {
      // No-op : déjà dismissed. Évite un re-render cascade de tous les subscribers
      // qui dépendent de dismissedPreviewSessions.
      if (state.dismissedPreviewSessions.has(sessionId)) return {};
      const next = new Set(state.dismissedPreviewSessions);
      next.add(sessionId);
      return { dismissedPreviewSessions: next };
    }),

  resetPreviewDismissal: (sessionId) =>
    set((state) => {
      if (!state.dismissedPreviewSessions.has(sessionId)) return {};
      const next = new Set(state.dismissedPreviewSessions);
      next.delete(sessionId);
      return { dismissedPreviewSessions: next };
    }),

  upsertSession: (s) =>
    set((state) => {
      // Lookup via sessionsById (O(1)) plutôt qu'un findIndex (O(N)).
      const existing = state.sessionsById[s.id];
      if (existing === s) return {};
      // Détecte les panes fermés intra-session (closePane individuel) pour
      // purger TOUTES les structures par-paneId — sinon le store accumule
      // ad vitam des stats / attention / agent-state pour des panes morts.
      const removedPaneIds: PaneId[] = [];
      if (existing) {
        for (const oldId of Object.keys(existing.panes)) {
          if (!(oldId in s.panes)) removedPaneIds.push(oldId);
        }
      }
      for (const pid of removedPaneIds) clearPaneData(pid);

      const sessions = existing
        ? state.sessions.map((x) => (x.id === s.id ? s : x))
        : [...state.sessions, s];

      const paneStatsPurge = purgePaneMaps(state.paneStats, removedPaneIds);
      const paneActivityPurge = purgePaneMaps(state.paneActivity, removedPaneIds);
      const paneAgentPurge = purgePaneMaps(state.paneAgentState, removedPaneIds);

      return {
        sessions,
        sessionsById: { ...state.sessionsById, [s.id]: s },
        activeSessionId: state.activeSessionId ?? s.id,
        ...(paneStatsPurge.changed ? { paneStats: paneStatsPurge.next } : null),
        ...(paneActivityPurge.changed ? { paneActivity: paneActivityPurge.next } : null),
        ...(paneAgentPurge.changed ? { paneAgentState: paneAgentPurge.next } : null)
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const target = state.sessionsById[id];
      const paneIds = target ? Object.keys(target.panes) : [];
      for (const paneId of paneIds) clearPaneData(paneId);
      const sessions = state.sessions.filter((s) => s.id !== id);
      const { [id]: _drop, ...sessionsById } = state.sessionsById;
      void _drop;
      // Purge les stats CPU/RAM des panes fermés — évite une fuite mémoire
      // sur les longues sessions (chaque pane gardait ses 150 samples ad vitam).
      const paneStatsPurge = purgePaneMaps(state.paneStats, paneIds);
      const paneActivityPurge = purgePaneMaps(state.paneActivity, paneIds);
      const paneAgentPurge = purgePaneMaps(state.paneAgentState, paneIds);
      return {
        sessions,
        sessionsById,
        paneStats: paneStatsPurge.next,
        paneActivity: paneActivityPurge.next,
        paneAgentState: paneAgentPurge.next,
        activeSessionId:
          state.activeSessionId === id ? sessions[0]?.id ?? null : state.activeSessionId
      };
    }),

  patchPane: (sessionId, paneId, patch) =>
    set((state) => {
      const target = state.sessionsById[sessionId];
      if (!target) return {};
      const cur = target.panes[paneId];
      if (!cur || cur.kind !== 'terminal') return {};
      // Change detection : si aucun champ du patch ne diffère de la valeur
      // courante, no-op. Évite la cascade de re-renders en aval (Sidebar,
      // SessionItem, TabBar) déclenchée par un nouvel objet Session quand
      // rien n'a effectivement bougé. Hot path : paneStatus IPC peut fire
      // à chaque chunk sous spew agent (lastOutputAt heartbeat 1Hz, etc.).
      let changed = false;
      const curRec = cur as unknown as Record<string, unknown>;
      const patchRec = patch as unknown as Record<string, unknown>;
      for (const k in patch) {
        if (curRec[k] !== patchRec[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return {};
      const updated: Session = {
        ...target,
        panes: { ...target.panes, [paneId]: { ...cur, ...patch } }
      };
      return {
        sessions: state.sessions.map((s) => (s.id === sessionId ? updated : s)),
        sessionsById: { ...state.sessionsById, [sessionId]: updated }
      };
    }),

  addToast: (t) =>
    set((state) => {
      const id = t.id ?? `${t.kind}-${uuid()}`;
      // Dédup robuste : kind + title + body + paneId. Sans body, on dédoublonnait
      // par accident des events différents qui partageaient un titre.
      const now = Date.now();
      const filtered = state.toasts.filter(
        (x) =>
          !(
            x.kind === t.kind &&
            x.title === t.title &&
            (x.body ?? '') === (t.body ?? '') &&
            (x.paneId ?? '') === (t.paneId ?? '') &&
            now - x.ts < 3000
          )
      );
      return { toasts: [...filtered, { ...t, id, ts: now }] };
    }),

  removeToast: (id) =>
    set((state) => {
      // Short-circuit : si l'id n'est pas présent, ne pas allouer un nouveau
      // tableau (évite un re-render de tous les Toast).
      if (!state.toasts.some((t) => t.id === id)) return {};
      return { toasts: state.toasts.filter((t) => t.id !== id) };
    }),

  recordEvent: (sessionId, event) =>
    set((state) => {
      const sess = state.sessionsById[sessionId];
      const entry: EventHistoryEntry = {
        event,
        sessionId,
        sessionName: sess?.name ?? 'Session inconnue'
      };
      // Cap EVENT_HISTORY_CAP, plus récents en tête. Évite slice() quand on
      // est encore sous le cap (sous-tableau identique en contenu).
      const eventHistory =
        state.eventHistory.length >= EVENT_HISTORY_CAP
          ? [entry, ...state.eventHistory.slice(0, EVENT_HISTORY_CAP - 1)]
          : [entry, ...state.eventHistory];
      return {
        lastEventBySession: { ...state.lastEventBySession, [sessionId]: event },
        eventHistory
      };
    }),

  markEventsRead: () =>
    set((state) => {
      // Short-circuit si tous les events sont déjà lus — avant, on rebuildait
      // l'array entier sur chaque appel (panel open/focus), déclenchant un
      // re-render cascade dans tous les subscribers à `eventHistory`.
      if (state.eventHistory.every((e) => e.readAt !== undefined)) return {};
      const now = Date.now();
      const eventHistory = state.eventHistory.map((e) =>
        e.readAt !== undefined ? e : { ...e, readAt: now }
      );
      return { eventHistory };
    }),

  clearEventHistory: () =>
    set((state) => (state.eventHistory.length === 0 ? {} : { eventHistory: [] })),

  bumpAttention: (paneId, level) =>
    set((state) => {
      // 'activity' : on skip si pane actif (sinon ça pollue inutilement).
      // 'alert' / 'needs-input' : toujours bumper, même actif (le user veut
      // un feedback visuel que vMux a détecté l'événement, surtout utile
      // quand il n'a qu'une seule session ouverte).
      if (level === 'activity') {
        const activeSess = state.activeSessionId
          ? state.sessionsById[state.activeSessionId]
          : undefined;
        if (activeSess?.activePaneId === paneId) return {};
      }
      const cur = state.paneActivity[paneId] ?? 'idle';
      const next = ATTENTION_RANK[level] > ATTENTION_RANK[cur] ? level : cur;
      if (next === cur) return {};
      return { paneActivity: { ...state.paneActivity, [paneId]: next } };
    }),

  clearAttention: (paneId) =>
    set((state) => {
      if (!(paneId in state.paneActivity)) return {};
      const { [paneId]: _drop, ...rest } = state.paneActivity;
      void _drop;
      return { paneActivity: rest };
    }),

  setAgentState: (paneId, agentState) =>
    set((state) => {
      // Idempotent : pas de re-render si valeur inchangée.
      if (state.paneAgentState[paneId] === agentState) return {};
      // `idle` est l'état par défaut — on ne stocke que les autres pour
      // éviter un objet qui croît indéfiniment. La lecture côté composant
      // retombe sur 'idle' si la clé est absente.
      if (agentState === 'idle') {
        if (!(paneId in state.paneAgentState)) return {};
        const { [paneId]: _drop, ...rest } = state.paneAgentState;
        void _drop;
        return { paneAgentState: rest };
      }
      return { paneAgentState: { ...state.paneAgentState, [paneId]: agentState } };
    }),

  pushStatSamples: (samples) =>
    set((state) => {
      if (samples.length === 0) return {};
      const next: Record<PaneId, PaneStatsHistory> = { ...state.paneStats };
      for (const s of samples) {
        // CRITICAL : lire `cur` depuis l'accumulateur `next` et pas `state.paneStats`,
        // sinon plusieurs samples pour le même paneId dans un batch écrasent les
        // intermédiaires (seul le dernier est correctement appendé).
        const cur = next[s.paneId];
        const curLen = cur?.cpu.length ?? 0;
        const isFull = curLen >= STATS_WINDOW;
        const newLen = isFull ? STATS_WINDOW : curLen + 1;
        const cpu = new Float32Array(newLen);
        const memory = new Float32Array(newLen);
        if (cur && curLen > 0) {
          const srcOffset = isFull ? 1 : 0;
          cpu.set(cur.cpu.subarray(srcOffset));
          memory.set(cur.memory.subarray(srcOffset));
        }
        cpu[newLen - 1] = s.cpu;
        memory[newLen - 1] = s.memory;
        next[s.paneId] = {
          cpu,
          memory,
          cores: s.cores,
          primed: cur?.primed === true || s.primed === true,
          last: { cpu: s.cpu, memory: s.memory, timestamp: s.timestamp }
        };
      }
      return { paneStats: next };
    }),

  pushSystemStats: (sample) =>
    set((state) => {
      const cur = state.systemCpuHistory;
      const curLen = cur.length;
      const isFull = curLen >= STATS_WINDOW;
      const newLen = isFull ? STATS_WINDOW : curLen + 1;
      const next = new Float32Array(newLen);
      if (curLen > 0) {
        const srcOffset = isFull ? 1 : 0;
        next.set(cur.subarray(srcOffset));
      }
      next[newLen - 1] = sample.cpu;
      return { systemStats: sample, systemCpuHistory: next };
    })
}));

// ============================================================
// Selector hooks — exports stables typés
// ============================================================
//
// Convention v5 : utiliser `useShallow` pour les selectors qui retournent un
// objet/array dérivé (sinon : risque de boucle infinie). Pour les selectors
// scalaires (string, number, boolean, ref directe), pas besoin de useShallow
// — l'équalité par défaut === suffit.

/** Session par id — O(1) via l'index. Retourne `undefined` si inexistante. */
export const useSessionById = (id: string | null | undefined): Session | undefined =>
  useSessionStore((s) => (id ? s.sessionsById[id] : undefined));

/** Settings courants — peut être null pendant le boot. */
export const useSettings = (): AppSettings | null => useSessionStore((s) => s.settings);

/** Niveau d'attention pour un pane (retombe sur 'idle' si absent). */
export const usePaneActivity = (paneId: PaneId): PaneAttention =>
  useSessionStore((s) => s.paneActivity[paneId] ?? 'idle');

/** État live d'agent pour un pane (retombe sur 'idle' si absent). */
export const usePaneAgentState = (paneId: PaneId): AgentRunState =>
  useSessionStore((s) => s.paneAgentState[paneId] ?? 'idle');

/** Stats CPU/RAM pour un pane (ref-stable tant que le pane ne reçoit pas de sample). */
export const usePaneStats = (paneId: PaneId): PaneStatsHistory | undefined =>
  useSessionStore((s) => s.paneStats[paneId]);

/** True si le sync-input est activé pour cette session. */
export const useIsSyncSession = (sessionId: string): boolean =>
  useSessionStore((s) => s.syncSessions.has(sessionId));

/** Re-export `useShallow` pour que les call-sites n'aient pas à connaître
 *  le chemin v5 `zustand/react/shallow`. */
export { useShallow };
