import Store from 'electron-store';
import log from 'electron-log/main';
import type { AppSettings, Pane, PaneId, PaneTree, Session, WindowState } from '@shared/types';
import { allPaneIds, firstLeaf } from '@shared/tree';

interface Schema {
  settings: AppSettings;
  sessions: Session[];
  windowState: WindowState;
  snippets: import('@shared/types').Snippet[];
  /** Flag set à false avant quit, true au boot — détection de crash. */
  gracefulShutdown: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'en',
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  defaultShell: 'pwsh',
  scrollback: 5000,
  cursorBlink: true,
  copyOnSelection: true,
  pasteOnRightClick: true,
  webglRenderer: true,
  sidebarWidth: 22,
  previewToastEnabled: true,
  previewAutoOpen: true,
  notificationsEnabled: true,
  previewDefaultSplit: 60,
  agentOverrides: {}
};

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1380,
  height: 880,
  isMaximized: false
};

const store = new Store<Schema>({
  name: 'cmux',
  defaults: {
    settings: DEFAULT_SETTINGS,
    sessions: [],
    windowState: DEFAULT_WINDOW_STATE,
    snippets: [
      {
        id: 'preset-ts-strict',
        name: 'TypeScript strict refactor',
        content:
          'Refactor {{file}} en TypeScript strict : pas de `any`, types explicites partout, gestion des cas null/undefined.',
        tags: ['refactor', 'typescript'],
        createdAt: Date.now()
      },
      {
        id: 'preset-tests',
        name: 'Tests unitaires',
        content:
          'Écris des tests unitaires complets pour {{file}}. Couvre les cas nominaux, edge cases, et erreurs.',
        tags: ['tests'],
        createdAt: Date.now()
      },
      {
        id: 'preset-doc',
        name: 'Documentation',
        content:
          'Documente {{file}} avec des JSDoc complets : description, paramètres, retours, exemples.',
        tags: ['docs'],
        createdAt: Date.now()
      }
    ],
    gracefulShutdown: true
  }
});

export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...(store.get('settings') as AppSettings) };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  store.set('settings', next);
  return next;
}

export function loadSessions(): Session[] {
  const raw = (store.get('sessions') as unknown[]) || [];
  const sessions: Session[] = [];
  for (const item of raw) {
    const migrated = migrateAndValidate(item);
    if (migrated) sessions.push(migrated);
  }
  return sessions;
}

/** Plafond pour éviter une croissance illimitée de l'historique. */
const MAX_PERSISTED_SESSIONS = 100;

export function saveSessions(sessions: Session[]): void {
  let toSave = sessions;
  if (sessions.length > MAX_PERSISTED_SESSIONS) {
    // Garde les plus récentes par createdAt.
    toSave = [...sessions]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, MAX_PERSISTED_SESSIONS);
  }
  store.set(
    'sessions',
    toSave.map((s) => {
      const panes: Record<PaneId, Pane> = {};
      for (const [id, p] of Object.entries(s.panes)) {
        if (p.kind === 'terminal') {
          panes[id] = {
            ...p,
            status:
              p.status === 'running' || p.status === 'starting' ? ('idle' as const) : p.status,
            pid: undefined
          };
        } else {
          panes[id] = p;
        }
      }
      return { ...s, panes };
    })
  );
}

// ============================================================
// Snippets
// ============================================================

export function listSnippets(): import('@shared/types').Snippet[] {
  return (store.get('snippets') as import('@shared/types').Snippet[]) || [];
}

export function saveSnippet(s: import('@shared/types').Snippet): import('@shared/types').Snippet[] {
  const all = listSnippets();
  const idx = all.findIndex((x) => x.id === s.id);
  const next = idx === -1 ? [...all, s] : all.map((x) => (x.id === s.id ? s : x));
  store.set('snippets', next);
  return next;
}

export function deleteSnippet(id: string): import('@shared/types').Snippet[] {
  const next = listSnippets().filter((s) => s.id !== id);
  store.set('snippets', next);
  return next;
}

// ============================================================
// Crash recovery
// ============================================================

export function getGracefulShutdown(): boolean {
  return store.get('gracefulShutdown') !== false;
}

export function setGracefulShutdown(v: boolean): void {
  store.set('gracefulShutdown', v);
}

export function getWindowState(): WindowState {
  return { ...DEFAULT_WINDOW_STATE, ...(store.get('windowState') as WindowState) };
}

export function saveWindowState(state: WindowState): void {
  store.set('windowState', state);
}

// ============================================================
// Migration / validation
// ============================================================

interface MaybeSession {
  id?: unknown;
  name?: unknown;
  cwd?: unknown;
  panes?: Record<string, Pane>;
  tree?: unknown;
  activePaneId?: unknown;
  branch?: unknown;
  ephemeralWorktree?: unknown;
  sourceRepo?: unknown;
  createdAt?: unknown;
}

function migrateAndValidate(raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as MaybeSession;
  if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.cwd !== 'string') {
    log.warn('[settings] dropping session: missing id/name/cwd');
    return null;
  }
  if (!s.panes || typeof s.panes !== 'object') {
    log.warn('[settings] dropping session: no panes');
    return null;
  }

  // Migration tree binaire → N-children. Dans l'ancien format, sizes était `[number, number]`
  // (toujours longueur 2). On le reconnaît mais le code n'a pas changé sur la forme du tree —
  // les helpers acceptent tableaux de longueur 2 OU plus. Donc rien à changer.
  // On valide juste que le tree est cohérent avec les panes.
  const tree = s.tree as PaneTree | undefined;
  if (!tree || !isValidTree(tree)) {
    log.warn(`[settings] dropping session ${s.id}: invalid tree`);
    return null;
  }

  // Tous les leafs du tree doivent exister dans panes. Sinon, drop.
  const leaves = allPaneIds(tree);
  for (const id of leaves) {
    if (!s.panes[id]) {
      log.warn(`[settings] dropping session ${s.id}: orphan leaf ${id}`);
      return null;
    }
  }

  // Re-valide activePaneId.
  let activePaneId: PaneId | undefined =
    typeof s.activePaneId === 'string' ? s.activePaneId : undefined;
  if (!activePaneId || !leaves.includes(activePaneId)) {
    activePaneId = firstLeaf(tree);
  }

  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    branch: typeof s.branch === 'string' ? s.branch : undefined,
    ephemeralWorktree: !!s.ephemeralWorktree,
    sourceRepo: typeof s.sourceRepo === 'string' ? s.sourceRepo : undefined,
    panes: s.panes,
    tree,
    activePaneId,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now()
  };
}

function isValidTree(tree: unknown): tree is PaneTree {
  if (!tree || typeof tree !== 'object') return false;
  const t = tree as { kind?: string; paneId?: unknown; direction?: string; children?: unknown[]; sizes?: unknown[] };
  if (t.kind === 'leaf') return typeof t.paneId === 'string';
  if (t.kind === 'split') {
    if (t.direction !== 'horizontal' && t.direction !== 'vertical') return false;
    if (!Array.isArray(t.children) || t.children.length < 2) return false;
    if (!Array.isArray(t.sizes) || t.sizes.length !== t.children.length) return false;
    return t.children.every((c) => isValidTree(c));
  }
  return false;
}
