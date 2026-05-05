import { create } from 'zustand';
import type {
  AgentAvailability,
  AgentPreset,
  AppSettings,
  DetectedEvent,
  PaneAttention,
  PaneId,
  Session,
  TerminalPane
} from '@shared/types';

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
  ts: number;
}

interface SessionStore {
  sessions: Session[];
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
}

/** Ordre d'escalade des niveaux d'attention. */
const ATTENTION_LEVEL: Record<PaneAttention, number> = {
  idle: 0,
  activity: 1,
  alert: 2,
  'needs-input': 3
};

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
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

  setSessions: (sessions) =>
    set((state) => ({
      sessions,
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
        activeSessionId: state.activeSessionId ?? s.id
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      return {
        sessions,
        activeSessionId:
          state.activeSessionId === id ? sessions[0]?.id ?? null : state.activeSessionId
      };
    }),

  patchPane: (sessionId, paneId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const cur = s.panes[paneId];
        if (!cur || cur.kind !== 'terminal') return s;
        return { ...s, panes: { ...s.panes, [paneId]: { ...cur, ...patch } } };
      })
    })),

  addToast: (t) =>
    set((state) => {
      const id = t.id ?? `${t.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
      const sess = state.sessions.find((s) => s.id === sessionId);
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
        const activeSess = state.sessions.find((s) => s.id === state.activeSessionId);
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
    })
}));
