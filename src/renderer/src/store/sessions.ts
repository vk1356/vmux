import { create } from 'zustand';
import { uuid } from '@shared/utils';
import { clearPaneData } from './paneDataBus';
import type {
  AgentAvailability,
  AgentPreset,
  AppSettings,
  DetectedEvent,
  DetectedEventKind,
  PaneAttention,
  PaneId,
  PaneStatSample,
  Session,
  TerminalPane
} from '@shared/types';

/** Capacité de la fenêtre glissante d'historique (samples par pane). */
export const STATS_WINDOW = 30;

export interface PaneStatsHistory {
  /** CPU% — fenêtre circulaire ; ordre chronologique (plus ancien en [0]).
   *  Float32Array : 1 allocation préallouée à la bonne taille (vs `Array` qui
   *  alloue + grandit + slice). Réduit la pression GC pour 30 panes × 1Hz. */
  cpu: Float32Array;
  /** RAM en octets — même fenêtre. */
  memory: Float32Array;
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
  /** Historique des events détectés (cap 200) — utilisé par le NotificationCenter. */
  eventHistory: Array<{ event: DetectedEvent; sessionId: string; sessionName: string; readAt?: number }>;
  /** Niveau d'attention par pane — `idle` quand le user a focus, sinon escalade. */
  paneActivity: Record<PaneId, PaneAttention>;
  /** Historique CPU/RAM par pane (fenêtre glissante de STATS_WINDOW samples). */
  paneStats: Record<PaneId, PaneStatsHistory>;

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
  /** Append samples CPU/RAM (push depuis le main toutes les 2s). */
  pushStatSamples: (samples: PaneStatSample[]) => void;
}

/** Ordre d'escalade des niveaux d'attention. */
const ATTENTION_LEVEL: Record<PaneAttention, number> = {
  idle: 0,
  activity: 1,
  alert: 2,
  'needs-input': 3
};

// Zustand v5 : la forme curried `create<T>()(...)` est requise pour bénéficier
// de l'inférence de types et rester compatible avec les middlewares (cf. docs
// Zustand v5 — migrating to v5).
/** Reconstruit l'index sessionsById depuis un array. */
function indexSessions(arr: Session[]): Record<string, Session> {
  const idx: Record<string, Session> = {};
  for (const s of arr) idx[s.id] = s;
  return idx;
}

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
  paneStats: {},

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
      const next = new Set(state.syncSessions);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { syncSessions: next };
    }),

  dismissPreview: (sessionId) =>
    set((state) => {
      const next = new Set(state.dismissedPreviewSessions);
      next.add(sessionId);
      return { dismissedPreviewSessions: next };
    }),

  resetPreviewDismissal: (sessionId) =>
    set((state) => {
      const next = new Set(state.dismissedPreviewSessions);
      next.delete(sessionId);
      return { dismissedPreviewSessions: next };
    }),

  upsertSession: (s) =>
    set((state) => {
      const idx = state.sessions.findIndex((x) => x.id === s.id);
      const sessions =
        idx === -1 ? [...state.sessions, s] : state.sessions.map((x) => (x.id === s.id ? s : x));
      return {
        sessions,
        sessionsById: { ...state.sessionsById, [s.id]: s },
        activeSessionId: state.activeSessionId ?? s.id
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const target = state.sessionsById[id];
      if (target) {
        for (const paneId of Object.keys(target.panes)) clearPaneData(paneId);
      }
      const sessions = state.sessions.filter((s) => s.id !== id);
      const { [id]: _drop, ...sessionsById } = state.sessionsById;
      void _drop;
      return {
        sessions,
        sessionsById,
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
      const filtered = state.toasts.filter(
        (x) =>
          !(
            x.kind === t.kind &&
            x.title === t.title &&
            (x.body ?? '') === (t.body ?? '') &&
            (x.paneId ?? '') === (t.paneId ?? '') &&
            Date.now() - x.ts < 3000
          )
      );
      return { toasts: [...filtered, { ...t, id, ts: Date.now() }] };
    }),

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  recordEvent: (sessionId, event) =>
    set((state) => {
      const sess = state.sessionsById[sessionId];
      const entry = {
        event,
        sessionId,
        sessionName: sess?.name ?? 'Session inconnue'
      };
      // Cap 200, plus récents en tête.
      const eventHistory = [entry, ...state.eventHistory].slice(0, 200);
      return {
        lastEventBySession: { ...state.lastEventBySession, [sessionId]: event },
        eventHistory
      };
    }),

  markEventsRead: () =>
    set((state) => ({
      eventHistory: state.eventHistory.map((e) => ({
        ...e,
        readAt: e.readAt ?? Date.now()
      }))
    })),

  clearEventHistory: () => set({ eventHistory: [] }),

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
      const next = ATTENTION_LEVEL[level] > ATTENTION_LEVEL[cur] ? level : cur;
      if (next === cur) return {};
      return { paneActivity: { ...state.paneActivity, [paneId]: next } };
    }),

  clearAttention: (paneId) =>
    set((state) => {
      if (!(paneId in state.paneActivity)) return {};
      const { [paneId]: _, ...rest } = state.paneActivity;
      void _;
      return { paneActivity: rest };
    }),

  pushStatSamples: (samples) =>
    set((state) => {
      if (samples.length === 0) return {};
      const next: Record<PaneId, PaneStatsHistory> = { ...state.paneStats };
      for (const s of samples) {
        const cur = next[s.paneId];
        const curLen = cur?.cpu.length ?? 0;
        const isFull = curLen >= STATS_WINDOW;
        const newLen = isFull ? STATS_WINDOW : curLen + 1;
        // Préalloue la taille finale en 1 seule allocation (vs slice + push qui
        // en faisait 2 + un grow interne du V8).
        const cpu = new Float32Array(newLen);
        const memory = new Float32Array(newLen);
        if (cur && curLen > 0) {
          // Quand plein : on shift d'1 (drop le plus ancien). Sinon : copie tout.
          const srcOffset = isFull ? 1 : 0;
          cpu.set(cur.cpu.subarray(srcOffset));
          memory.set(cur.memory.subarray(srcOffset));
        }
        cpu[newLen - 1] = s.cpu;
        memory[newLen - 1] = s.memory;
        next[s.paneId] = {
          cpu,
          memory,
          last: { cpu: s.cpu, memory: s.memory, timestamp: s.timestamp }
        };
      }
      return { paneStats: next };
    })
}));
