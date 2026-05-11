import os from 'node:os';
import { Conf, type Migration } from 'electron-conf/main';
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
  scrollback: 50000,
  cursorBlink: true,
  copyOnSelection: true,
  pasteOnRightClick: true,
  webglRenderer: true,
  sidebarWidth: 22,
  previewToastEnabled: true,
  previewAutoOpen: true,
  notificationsEnabled: true,
  notificationSound: 'default',
  autoLaunch: false,
  previewDefaultSplit: 60,
  agentOverrides: {},
  onboardingCompleted: false,
  autoRestoreOnBoot: true,
  lastActiveSessionId: null,
  cdpEnabled: true,
  cdpPort: 9222,
  claudeCommandsEnabled: true
};

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1380,
  height: 880,
  isMaximized: false
};

// Migrations électron-conf : versionnent le schéma de config. v1 = baseline post
// 0.7.x (post-introduction des champs cdpEnabled / claudeCommandsEnabled).
// Toute migration future doit incrémenter la version et compléter ce tableau —
// electron-conf rejouera tous les hooks dont la version est > celle du fichier.
const migrations: Migration<Schema>[] = [
  {
    version: 1,
    hook: (instance, fromVersion): void => {
      // Si on vient d'un fichier sans __internal__.migrations (v0), s'assure que
      // les nouveaux champs ont une valeur. set fait un merge avec les defaults
      // donc on touche uniquement les nœuds ciblés.
      const cur = (instance.get('settings') as Partial<AppSettings>) ?? {};
      const merged: AppSettings = { ...DEFAULT_SETTINGS, ...cur };
      instance.set('settings', merged);
      log.info(`[settings] migrated config from v${fromVersion} to v1`);
    }
  }
];

let store: Conf<Schema>;
try {
  store = new Conf<Schema>({
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
    },
    migrations
  });
} catch (err) {
  // electron-conf throw si JSON corrompu, ajv refuse les valeurs, ou si un
  // schema reservé est violé. Plutôt que de crasher au boot, on log et on
  // retombe sur un store en mémoire seule — l'utilisateur ne perd pas l'app,
  // les modifs ne persisteront pas tant que le fichier n'est pas réparé.
  log.error('[settings] failed to load persisted config — falling back to in-memory store', err);
  store = new Conf<Schema>({
    name: 'cmux-fallback-memory',
    dir: os.tmpdir(),
    defaults: {
      settings: DEFAULT_SETTINGS,
      sessions: [],
      windowState: DEFAULT_WINDOW_STATE,
      snippets: [],
      gracefulShutdown: true
    }
  });
}

// ============================================================
// Debounced writes
// ============================================================
//
// electron-conf.set() écrit immédiatement (atomic via .tmp + rename interne).
// Sur les chemins « rafale » (paneStats, ptyManager.saveSessions appelé à chaque
// status change, settings UI sliders), ça lockait le main thread.
//
// On coalesce par clé : la dernière valeur reçue dans une fenêtre de 250ms est
// flushée. flushPendingWrites() doit être appelé avant quit pour ne pas perdre
// la mise à jour finale (notamment gracefulShutdown=true).

const WRITE_DEBOUNCE_MS = 250;
type PendingMap = { [K in keyof Schema]?: Schema[K] };
const pending: PendingMap = {};
let writeTimer: NodeJS.Timeout | null = null;

function scheduleWrite<K extends keyof Schema>(key: K, value: Schema[K]): void {
  pending[key] = value;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushPendingWrites();
  }, WRITE_DEBOUNCE_MS);
}

/** Écrit immédiatement toutes les valeurs en attente. Idempotent. */
export function flushPendingWrites(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const entries = Object.entries(pending) as [keyof Schema, Schema[keyof Schema]][];
  if (entries.length === 0) return;
  // Vide pending AVANT d'écrire : si store.set throw (ajv refuse une valeur),
  // on ne reboucle pas indéfiniment sur la même valeur invalide.
  for (const key of Object.keys(pending) as (keyof Schema)[]) {
    delete pending[key];
  }
  try {
    // Batch set : 1 seul write fichier au lieu de N.
    const patch: Partial<Schema> = {};
    for (const [k, v] of entries) {
      (patch as Record<string, unknown>)[k as string] = v;
    }
    store.set(patch as Schema);
  } catch (err) {
    log.error('[settings] flush failed', err);
  }
}

// ============================================================
// Settings
// ============================================================

export function getSettings(): AppSettings {
  // Merge avec defaults : si le fichier user est antérieur à l'ajout d'un
  // champ, le reste de l'app reçoit la valeur par défaut au lieu de undefined.
  const cur = pending.settings ?? (store.get('settings') as AppSettings | undefined);
  return { ...DEFAULT_SETTINGS, ...(cur ?? {}) };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  scheduleWrite('settings', next);
  return next;
}

// ============================================================
// Sessions
// ============================================================

export function loadSessions(): Session[] {
  const raw = (store.get('sessions') as unknown[]) || [];
  if (!Array.isArray(raw)) {
    log.warn('[settings] sessions key is not an array — resetting');
    return [];
  }
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
  const serialized: Session[] = toSave.map((s) => {
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
  });
  scheduleWrite('sessions', serialized);
}

// ============================================================
// Snippets
// ============================================================

export function listSnippets(): import('@shared/types').Snippet[] {
  const cur = pending.snippets ?? (store.get('snippets') as import('@shared/types').Snippet[]);
  return Array.isArray(cur) ? cur : [];
}

export function saveSnippet(s: import('@shared/types').Snippet): import('@shared/types').Snippet[] {
  const all = listSnippets();
  const idx = all.findIndex((x) => x.id === s.id);
  const next = idx === -1 ? [...all, s] : all.map((x) => (x.id === s.id ? s : x));
  scheduleWrite('snippets', next);
  return next;
}

export function deleteSnippet(id: string): import('@shared/types').Snippet[] {
  const next = listSnippets().filter((s) => s.id !== id);
  scheduleWrite('snippets', next);
  return next;
}

// ============================================================
// Crash recovery
// ============================================================

export function getGracefulShutdown(): boolean {
  const cur = pending.gracefulShutdown ?? store.get('gracefulShutdown');
  return cur !== false;
}

export function setGracefulShutdown(v: boolean): void {
  // gracefulShutdown=true au shutdown DOIT être flushé synchroniquement avant
  // app.exit, sinon le boot suivant détectera un faux crash. On bypass le
  // debounce pour cette clé critique.
  pending.gracefulShutdown = v;
  flushPendingWrites();
}

// ============================================================
// Window state
// ============================================================

export function getWindowState(): WindowState {
  const cur = pending.windowState ?? (store.get('windowState') as WindowState | undefined);
  return { ...DEFAULT_WINDOW_STATE, ...(cur ?? {}) };
}

export function saveWindowState(state: WindowState): void {
  scheduleWrite('windowState', state);
}

// ============================================================
// Migration / validation des sessions
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
