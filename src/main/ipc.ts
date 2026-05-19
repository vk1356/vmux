import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IPC,
  type AppSettings,
  type ClipboardRichResult,
  type CreateSessionInput,
  type DetectedEvent,
  type IpcResult,
  type Lang,
  type McpServer,
  type PaneId,
  type PaneStatSample,
  type PtySize,
  type Snippet,
  type SplitDirection,
  type SplitPaneInput,
  type SystemStatsSample
} from '@shared/types';
import { DEFAULT_AGENTS } from '@shared/agents';
import { ptyManager } from './pty-manager';
import { ptyStats } from './pty-stats';
import { inspectRepo, listWorktrees } from './worktree-manager';
import {
  deleteSnippet,
  getSettings,
  listSnippets,
  saveSnippet,
  updateSettings
} from './settings-store';
import { defaultDiagnosticFilename, saveDiagnosticTo } from './diagnostic';
import { checkAgents } from './agent-check';
import { notifBundle } from '@shared/notif-i18n';
import type { TreePath } from '@shared/tree';
import type { LayoutPreset } from '@shared/layouts';
import { createNotificationService, preloadNotificationIcon } from './notification-service';
import { createDetachedWindow, syncAutoLaunch } from './window';
import {
  addServer as mcpAdd,
  getConfigPath as mcpConfigPath,
  listServers as mcpList,
  removeServer as mcpRemove,
  toggleServer as mcpToggle
} from './mcp-manager';

// ============================================================
// Validation helpers (IPC boundary = security perimeter)
// ============================================================

/** Cap commun pour toute string scalaire passée par IPC. Évite qu'un renderer
 *  bogué (ou compromis) ne nous balance des chaînes multi-MB qu'on ferait
 *  trainer en mémoire ou dans des stores. 4 KiB couvre largement les paths,
 *  noms de session, URLs, labels, etc. */
const MAX_STRING_LEN = 4096;

/** Cap dédié pour `clipboard:write` — paste cli, snippets : 1 MiB max. */
const MAX_CLIPBOARD_LEN = 1024 * 1024;

/** Cap des IDs (paneId, sessionId, snippet.id) — UUID = 36 chars, on laisse
 *  de la marge pour des IDs custom. */
const MAX_ID_LEN = 128;

/** Cap pour les labels affichés (renamePane, renameSession). Le pty-manager
 *  re-trim de toute façon, mais on évite de transporter 4 KiB pour 60 chars
 *  utiles. */
const MAX_LABEL_LEN = 200;

function isNonEmptyString(v: unknown, max = MAX_STRING_LEN): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && v.indexOf('\0') === -1;
}

function isString(v: unknown, max = MAX_STRING_LEN): v is string {
  return typeof v === 'string' && v.length <= max && v.indexOf('\0') === -1;
}

function isId(v: unknown): v is string {
  return isNonEmptyString(v, MAX_ID_LEN);
}

/** Validation de PtySize venu du renderer — rejette les valeurs non finies ou
 *  négatives qui feraient crasher node-pty.resize(). */
function isValidPtySize(s: unknown): s is PtySize {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.cols === 'number' &&
    typeof o.rows === 'number' &&
    Number.isFinite(o.cols) &&
    Number.isFinite(o.rows) &&
    o.cols > 0 &&
    o.rows > 0 &&
    o.cols <= 10000 &&
    o.rows <= 10000
  );
}

/** Rejette une string qui contient un NUL byte, des séquences traversantes
 *  ou des préfixes Windows dangereux. Retourne `true` si le chemin EST unsafe. */
function isUnsafePath(p: unknown): boolean {
  if (typeof p !== 'string' || !p) return true;
  if (p.length > MAX_STRING_LEN) return true;
  if (p.indexOf('\0') !== -1) return true;
  if (process.platform === 'win32') {
    // \\server\share, \\.\device, \\?\
    if (p.startsWith('\\\\')) return true;
    // /dev/ etc. n'existe pas sur Windows mais on les rejette quand même.
    if (/^\/+(?:dev|proc|sys)\//i.test(p)) return true;
  }
  return false;
}

/** Normalise + valide un chemin reçu du renderer. Retourne le chemin résolu
 *  absolu, ou `null` si invalide. Mutualise les checks `isUnsafePath` +
 *  `path.resolve` pour ne pas oublier le second à un endroit. */
function safePath(p: unknown): string | null {
  if (isUnsafePath(p)) return null;
  try {
    const resolved = path.resolve(p as string);
    if (resolved.indexOf('\0') !== -1) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Validation stricte d'URL http(s) côté IPC — bloque javascript:/file:/data:/etc. */
function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > MAX_STRING_LEN) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  // Refuse les NUL et autres ctrl chars qui peuvent masquer le scheme.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(u)) return false;
  try {
    // URL parser valide la structure (host non vide, port valide…). Sans ça,
    // `http://` passerait le regex mais serait inutile.
    const parsed = new URL(u);
    if (!parsed.host) return false;
    return true;
  } catch {
    return false;
  }
}

function isSplitDirection(d: unknown): d is SplitDirection {
  return d === 'horizontal' || d === 'vertical';
}

/** Liste blanche des clés AppSettings — empêche les attaques prototype-pollution
 *  (`__proto__`, `constructor`, `prototype`) et la fuite de clés inconnues vers
 *  electron-conf. */
const ALLOWED_SETTINGS_KEYS = new Set<keyof AppSettings>([
  'theme', 'language', 'fontFamily', 'fontSize', 'defaultShell', 'scrollback',
  'cursorBlink', 'copyOnSelection', 'pasteOnRightClick', 'webglRenderer',
  'sidebarWidth', 'previewToastEnabled', 'previewAutoOpen', 'notificationsEnabled',
  'notificationSound', 'notificationSoundPath', 'autoLaunch', 'previewDefaultSplit',
  'agentOverrides', 'onboardingCompleted', 'autoRestoreOnBoot',
  'lastActiveSessionId', 'cdpEnabled', 'cdpPort', 'claudeCommandsEnabled'
]);

function sanitizeSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (!patch || typeof patch !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (!ALLOWED_SETTINGS_KEYS.has(k as keyof AppSettings)) continue;
    out[k] = (patch as Record<string, unknown>)[k];
  }
  return out as Partial<AppSettings>;
}

/** Validation structurelle d'un McpServer venu du renderer. Le command/args/env
 *  ne sont pas filtrés sémantiquement (l'user peut légitimement configurer
 *  n'importe quel serveur MCP) mais on vérifie shape/limites pour éviter qu'un
 *  bug renderer écrive du JSON corrompu dans `~/.claude.json`. */
function isValidMcpServer(s: unknown): s is McpServer {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 80) return false;
  if (o.name.indexOf('\0') !== -1 || /[/\\]/.test(o.name)) return false;
  if (o.type !== 'stdio' && o.type !== 'http' && o.type !== 'sse') return false;
  if (o.command !== undefined) {
    if (typeof o.command !== 'string' || o.command.length > 2048) return false;
    if (o.command.indexOf('\0') !== -1) return false;
  }
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.length > 64) return false;
    for (const a of o.args) {
      if (typeof a !== 'string' || a.length > MAX_STRING_LEN || a.indexOf('\0') !== -1) return false;
    }
  }
  if (o.env !== undefined) {
    if (!o.env || typeof o.env !== 'object' || Array.isArray(o.env)) return false;
    const env = o.env as Record<string, unknown>;
    const keys = Object.keys(env);
    if (keys.length > 64) return false;
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
      if (k.length > 128 || k.indexOf('\0') !== -1) return false;
      const v = env[k];
      if (typeof v !== 'string' || v.length > MAX_STRING_LEN || v.indexOf('\0') !== -1) return false;
    }
  }
  if (o.url !== undefined) {
    if (typeof o.url !== 'string' || o.url.length > MAX_STRING_LEN) return false;
    if (o.type !== 'stdio' && !isHttpUrl(o.url)) return false;
  }
  if (o.disabled !== undefined && typeof o.disabled !== 'boolean') return false;
  return true;
}

function isValidSnippet(s: unknown): s is Snippet {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > MAX_ID_LEN) return false;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > MAX_LABEL_LEN) return false;
  if (typeof o.content !== 'string' || o.content.length > 64 * 1024) return false;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return false;
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags) || o.tags.length > 32) return false;
    for (const t of o.tags) {
      if (typeof t !== 'string' || t.length > 64) return false;
    }
  }
  return true;
}

function isValidCreateSessionInput(v: unknown): v is CreateSessionInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length > MAX_LABEL_LEN) return false;
  if (typeof o.agentId !== 'string' || o.agentId.length === 0 || o.agentId.length > 64) return false;
  if (typeof o.cwd !== 'string' || isUnsafePath(o.cwd)) return false;
  if (o.initialInput !== undefined) {
    if (typeof o.initialInput !== 'string' || o.initialInput.length > 64 * 1024) return false;
  }
  if (o.newWorktree !== undefined) {
    if (!o.newWorktree || typeof o.newWorktree !== 'object') return false;
    const w = o.newWorktree as Record<string, unknown>;
    if (typeof w.branch !== 'string' || w.branch.length === 0 || w.branch.length > MAX_LABEL_LEN) return false;
    if (w.base !== undefined && (typeof w.base !== 'string' || w.base.length > MAX_LABEL_LEN)) return false;
    if (w.parentDir !== undefined && (typeof w.parentDir !== 'string' || isUnsafePath(w.parentDir))) return false;
  }
  return true;
}

function isValidSplitPaneInput(v: unknown): v is SplitPaneInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!isId(o.sessionId) || !isId(o.paneId)) return false;
  if (!isSplitDirection(o.direction)) return false;
  if (o.agentId !== undefined && (typeof o.agentId !== 'string' || o.agentId.length > 64)) return false;
  if (o.cwd !== undefined && (typeof o.cwd !== 'string' || isUnsafePath(o.cwd))) return false;
  if (o.url !== undefined && !isHttpUrl(o.url)) return false;
  if (o.followsPaneId !== undefined && !isId(o.followsPaneId)) return false;
  return true;
}

function isValidTreePath(v: unknown): v is TreePath {
  if (!Array.isArray(v) || v.length > 64) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1024) return false;
  }
  return true;
}

function isValidSizesArray(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 16) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return false;
  }
  return true;
}

const VALID_LAYOUT_PRESETS = new Set<LayoutPreset>([
  'tiled', 'even-horizontal', 'even-vertical', 'main-stack'
]);
function isValidLayoutPreset(v: unknown): v is LayoutPreset {
  return typeof v === 'string' && VALID_LAYOUT_PRESETS.has(v as LayoutPreset);
}

/** Validation de l'origine du sender. On accepte uniquement les sources
 *  internes à l'app : `file://` (renderer packagé), `http(s)://localhost:*`
 *  (vite dev server) et `devtools://`. Tout autre origine (page web ouverte
 *  dans un <webview>, iframe distant…) ne doit JAMAIS atteindre nos handlers.
 *
 *  Référence : Electron security guideline #17 — "Validate the sender of all
 *  IPC messages". https://www.electronjs.org/docs/latest/tutorial/security */
function isTrustedSender(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const frame = e.senderFrame;
  if (!frame) return false;
  const url = frame.url;
  // `about:blank` peut apparaître très brièvement pendant le load — refuser
  // par défaut, le renderer redemande après pour les handlers idempotents.
  if (!url || url === 'about:blank') return false;
  if (url.startsWith('file://')) return true;
  if (url.startsWith('devtools://')) return true;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1')) {
      return true;
    }
  } catch {
    /* fallthrough */
  }
  return false;
}

/** Wrap async/sync handler dans un IpcResult, log l'erreur sans la propager
 *  comme rejected promise (sinon Electron renvoie `Error` sérialisé incomplet
 *  côté renderer). */
function safe<T>(name: string, fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  return Promise.resolve()
    .then(() => fn())
    .then((data) => ({ ok: true as const, data }))
    .catch((err: unknown) => {
      log.error(`[ipc:${name}]`, err);
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error };
    });
}

/** Throttle un publisher d'events leading+trailing : émet immédiatement le
 *  premier sample, puis coalesce les suivants sur `intervalMs` en ne gardant
 *  que la dernière valeur. Évite de saturer l'IPC quand pty-stats produit
 *  à 1Hz × N panes et qu'on a 3+ fenêtres détachées. */
function throttle<T>(intervalMs: number, fn: (v: T) => void): (v: T) => void {
  let last = 0;
  let pending: T | undefined;
  let timer: NodeJS.Timeout | null = null;
  return (v: T): void => {
    const now = Date.now();
    const since = now - last;
    if (since >= intervalMs) {
      last = now;
      pending = undefined;
      if (timer) { clearTimeout(timer); timer = null; }
      fn(v);
      return;
    }
    pending = v;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending === undefined) return;
      last = Date.now();
      const next = pending;
      pending = undefined;
      fn(next);
    }, intervalMs - since);
  };
}

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  // Résolution async de l'icône de notif — non bloquant.
  void preloadNotificationIcon();

  /** Map sessionId → fenêtre détachée. Multi-window : une session peut être
   *  ouverte dans sa propre BrowserWindow en plus de la fenêtre principale.
   *  La Map est nettoyée au close de la window. */
  const detachedWindows = new Map<string, BrowserWindow>();

  /** Set des webContents.id qu'on a explicitement créés (mainWindow + détachées).
   *  Sert de barrière de défense supplémentaire pour `senderWin` — on ne veut
   *  jamais que `BrowserWindow.fromWebContents(e.sender)` nous retourne une
   *  window inattendue (ex. un <webview>). */
  const trustedWebContentIds = new Set<number>();

  const registerTrustedWindow = (win: BrowserWindow): void => {
    if (win.isDestroyed()) return;
    const id = win.webContents.id;
    trustedWebContentIds.add(id);
    win.on('closed', () => {
      trustedWebContentIds.delete(id);
    });
  };
  // Enregistre la mainWindow dès qu'elle existe — déféré car registerIpc()
  // peut être appelé avant que la mainWindow soit construite.
  const main = getMainWindow();
  if (main) registerTrustedWindow(main);

  /** Broadcast IPC à toutes les fenêtres vivantes (main + détachées).
   *  Utilisé pour les events globaux (systemStats, updateStatus…). Pour les
   *  events session/pane-scope, préférer `sendForSession` / `sendForPane`. */
  const safeSend = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      w.webContents.send(channel, ...args);
    }
  };

  /** Helper privé : envoie à une window si elle est vivante. */
  const sendTo = (w: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void => {
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, ...args);
  };

  /** Route un event vers la mainWindow + (si elle existe) la window détachée
   *  qui possède cette session. Évite de fanout à toutes les windows : avant,
   *  3 fenêtres détachées multipliaient le coût IPC par 4 sur chaque chunk PTY. */
  const sendForSession = (sessionId: string | undefined, channel: string, ...args: unknown[]): void => {
    sendTo(getMainWindow(), channel, ...args);
    if (sessionId) {
      const w = detachedWindows.get(sessionId);
      if (w && w !== getMainWindow()) sendTo(w, channel, ...args);
    }
  };

  /** Route un event pane-scope vers les windows propriétaires de la session. */
  const sendForPane = (paneId: string, channel: string, ...args: unknown[]): void => {
    sendForSession(ptyManager.sessionForPane(paneId), channel, ...args);
  };

  const notifService = createNotificationService(getMainWindow, safeSend);

  // ============================================================
  // Registration helpers — `handle*` valide aussi le sender et wrap dans `safe`.
  // ============================================================

  type InvokeHandler<T> = (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T;

  /** handle() simple — checks sender, ne wrap pas dans IpcResult.
   *  Pour les channels qui retournent une valeur brute (ex. `app:version`).
   *  Idempotent : removeHandler() avant register évite le throw "second handler"
   *  sur hot-reload Vite HMR. Le try/catch garantit qu'aucun handler ne peut
   *  propager une rejection vers le main process — erreur loguée, null retourné. */
  function handle<T>(channel: string, fn: InvokeHandler<T>): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, ...args: unknown[]) => {
      if (!isTrustedSender(e)) {
        log.warn(`[ipc:${channel}] rejected untrusted sender:`, e.senderFrame?.url ?? '<none>');
        return null as unknown as T;
      }
      try {
        return await fn(e, ...args);
      } catch (err) {
        log.error(`[ipc:${channel}]`, err);
        return null as unknown as T;
      }
    });
  }

  /** handle() wrappé dans `safe` : retourne `IpcResult<T>`.
   *  Idempotent : removeHandler() avant register (même raison que handle()). */
  function handleResult<T>(channel: string, fn: InvokeHandler<T>): void {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, ...args: unknown[]): Promise<IpcResult<T> | null> => {
      if (!isTrustedSender(e)) {
        log.warn(`[ipc:${channel}] rejected untrusted sender:`, e.senderFrame?.url ?? '<none>');
        return null;
      }
      return safe<T>(channel, () => fn(e, ...args));
    });
  }

  /** on() pour les channels fire-and-forget (paneWrite, paneResize…). */
  function on(channel: string, fn: (e: Electron.IpcMainEvent, ...args: unknown[]) => void): void {
    ipcMain.on(channel, (e, ...args: unknown[]) => {
      if (!isTrustedSender(e)) return;
      fn(e, ...args);
    });
  }

  // ---------- App ----------
  handle(IPC.appVersion, () => app.getVersion());

  // ---------- Window ----------
  // Tous les handlers ciblent la fenêtre **émettrice** (sender) plutôt que la
  // mainWindow : sinon le bouton minimize d'une fenêtre détachée minimiserait
  // la fenêtre principale. Fallback sur mainWindow pour les invocations sans
  // sender utilisable (rare). On vérifie aussi que le webContents fait partie
  // de notre set `trustedWebContentIds` : sinon un <webview> pourrait minimize
  // la window parent.
  const senderWin = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    if (!trustedWebContentIds.has(e.sender.id)) return getMainWindow();
    return BrowserWindow.fromWebContents(e.sender) ?? getMainWindow();
  };
  handle(IPC.windowMinimize, (e) => { senderWin(e)?.minimize(); });
  handle(IPC.windowMaximize, (e) => {
    const w = senderWin(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  handle(IPC.windowClose, (e) => { senderWin(e)?.close(); });
  handle(IPC.windowIsMaximized, (e) => senderWin(e)?.isMaximized() ?? false);

  handle(IPC.windowDetachSession, (_e, sessionId: unknown) => {
    if (!isId(sessionId)) return;
    // Refuse silencieusement si la session n'existe pas (race avec un remove).
    const exists = ptyManager.list().some((s) => s.id === sessionId);
    if (!exists) return;
    // Idempotent : focus la fenêtre détachée existante au lieu d'en empiler une nouvelle.
    const cur = detachedWindows.get(sessionId);
    if (cur && !cur.isDestroyed()) {
      if (cur.isMinimized()) cur.restore();
      cur.focus();
      return;
    }
    const win = createDetachedWindow(sessionId);
    detachedWindows.set(sessionId, win);
    registerTrustedWindow(win);
    win.on('closed', () => {
      // Nettoie la map seulement si l'entrée pointe encore sur cette window
      // (au cas où une race aurait déjà ré-attribué la slot).
      if (detachedWindows.get(sessionId) === win) {
        detachedWindows.delete(sessionId);
      }
    });
  });

  // ---------- Agents ----------
  // DEFAULT_AGENTS est `as const satisfies readonly AgentPreset[]` — on
  // matérialise une copie mutable pour `checkAgents` (signature `AgentPreset[]`).
  handle(IPC.agentsList, () => DEFAULT_AGENTS);
  handle(IPC.agentsCheck, () => checkAgents([...DEFAULT_AGENTS]));

  // ---------- Sessions ----------
  handle(IPC.sessionList, () => ptyManager.list());
  handleResult(IPC.sessionCreate, (_e, input: unknown) => {
    if (!isValidCreateSessionInput(input)) throw new Error('invalid session input');
    return ptyManager.createSession(input);
  });
  handle(IPC.sessionRemove, async (_e, id: unknown) => {
    if (!isId(id)) return;
    // Si la session était détachée dans une fenêtre séparée, on la ferme
    // d'abord — sinon le renderer détaché reste sur un sessionId fantôme.
    const detached = detachedWindows.get(id);
    if (detached && !detached.isDestroyed()) {
      detached.close();
    }
    detachedWindows.delete(id);
    await ptyManager.removeSession(id);
  });

  // ---------- Panes ----------
  handleResult(IPC.paneSplit, (_e, input: unknown) => {
    if (!isValidSplitPaneInput(input)) throw new Error('invalid split input');
    return ptyManager.splitPane(input);
  });
  handleResult(IPC.paneClose, (_e, sessionId: unknown, paneId: unknown) => {
    if (!isId(sessionId) || !isId(paneId)) throw new Error('invalid id');
    return ptyManager.closePane(sessionId, paneId);
  });
  handle(IPC.paneFocus, (_e, sessionId: unknown, paneId: unknown) => {
    if (!isId(sessionId) || !isId(paneId)) return;
    ptyManager.focusPane(sessionId, paneId);
  });
  handleResult(IPC.paneRestart, (_e, sessionId: unknown, paneId: unknown) => {
    if (!isId(sessionId) || !isId(paneId)) throw new Error('invalid id');
    return ptyManager.restartPane(sessionId, paneId);
  });
  handle(IPC.paneResizeSplit, (_e, sessionId: unknown, splitPath: unknown, sizes: unknown) => {
    if (!isId(sessionId) || !isValidTreePath(splitPath) || !isValidSizesArray(sizes)) return;
    ptyManager.resizeSplit(sessionId, splitPath, sizes);
  });
  handle(IPC.paneSetUrl, (_e, sessionId: unknown, paneId: unknown, url: unknown) => {
    if (!isId(sessionId) || !isId(paneId)) return;
    // Refuse tout schéma non-http (javascript:, file:, data:…) à la frontière
    // IPC. La validation est aussi appliquée côté <webview> mais il vaut mieux
    // ne JAMAIS persister une URL malicieuse côté main.
    if (!isHttpUrl(url)) return;
    ptyManager.setPaneUrl(sessionId, paneId, url);
  });
  handleResult(IPC.paneRelayout, (_e, sessionId: unknown, preset: unknown) => {
    if (!isId(sessionId)) throw new Error('invalid session id');
    if (!isValidLayoutPreset(preset)) throw new Error('invalid layout preset');
    return ptyManager.relayout(sessionId, preset);
  });
  handleResult(IPC.paneRename, (_e, sessionId: unknown, paneId: unknown, label: unknown) => {
    if (!isId(sessionId) || !isId(paneId)) throw new Error('invalid id');
    if (!isString(label, MAX_LABEL_LEN)) throw new Error('invalid label');
    return ptyManager.renamePane(sessionId, paneId, label);
  });
  handleResult(IPC.paneRemoveUrl, (_e, sessionId: unknown, paneId: unknown, url: unknown) => {
    if (!isId(sessionId) || !isId(paneId)) throw new Error('invalid id');
    if (!isHttpUrl(url)) throw new Error('invalid url');
    return ptyManager.removeUrlFromPane(sessionId, paneId, url);
  });
  handleResult(IPC.sessionRename, (_e, sessionId: unknown, name: unknown) => {
    if (!isId(sessionId)) throw new Error('invalid session id');
    if (!isString(name, MAX_LABEL_LEN)) throw new Error('invalid name');
    return ptyManager.renameSession(sessionId, name);
  });
  handleResult(IPC.sessionRestartAll, (_e, sessionId: unknown) => {
    if (!isId(sessionId)) throw new Error('invalid session id');
    return ptyManager.restartAll(sessionId);
  });
  handleResult(IPC.sessionTogglePin, (_e, sessionId: unknown) => {
    if (!isId(sessionId)) throw new Error('invalid session id');
    return ptyManager.togglePin(sessionId);
  });
  handleResult(IPC.sessionSetColor, (_e, sessionId: unknown, color: unknown) => {
    if (!isId(sessionId)) throw new Error('invalid session id');
    // pty-manager fait son propre regex check, on accepte null|string court.
    if (color !== null && (typeof color !== 'string' || color.length > 32)) {
      throw new Error('invalid color');
    }
    return ptyManager.setSessionColor(sessionId, color);
  });
  handleResult(IPC.paneOpenPreview, (_e, sessionId: unknown, terminalPaneId: unknown, url: unknown) => {
    if (!isId(sessionId) || !isId(terminalPaneId)) throw new Error('invalid pane');
    if (!isHttpUrl(url)) throw new Error('invalid url');
    return ptyManager.splitPane({
      sessionId,
      paneId: terminalPaneId,
      direction: 'horizontal',
      url,
      followsPaneId: terminalPaneId
    });
  });

  // Hot path (chaque keystroke) — validation minimale pour rejeter les
  // payloads malformés sans logger (sinon flood des logs en cas de bug).
  // On n'utilise pas le wrapper `on()` ici pour économiser le check sender
  // sur chaque keystroke ? Non — on garde le check, l'impact est négligeable
  // (~1 lookup Set + 1 startsWith) et l'attaque "renderer compromis qui
  // write n'importe quoi dans le PTY" est plausible.
  on(IPC.paneWrite, (_e, paneId: unknown, data: unknown) => {
    if (typeof paneId !== 'string' || paneId.length === 0 || paneId.length > MAX_ID_LEN) return;
    if (typeof data !== 'string') return;
    // Bound un payload paste géant — l'user qui colle 10 MB n'a aucune raison
    // valable d'aller au-delà de MAX_CLIPBOARD_LEN d'un coup.
    if (data.length > MAX_CLIPBOARD_LEN) return;
    ptyManager.writePane(paneId, data);
  });
  on(IPC.paneResize, (_e, paneId: unknown, size: unknown) => {
    if (typeof paneId !== 'string' || paneId.length === 0 || paneId.length > MAX_ID_LEN) return;
    if (!isValidPtySize(size)) return;
    ptyManager.resizePane(paneId, size);
  });

  // ============================================================
  // Forward des events ptyManager → renderer.
  // Le main process est process-singleton ; ptyManager est instancié une fois.
  // On enregistre nos listeners ici sans `off()` au teardown : les listeners
  // vivent autant que le process. `safeSend`/`sendForPane` gardent contre le
  // cas où la webContents est destroyed.
  // ============================================================

  ptyManager.on('paneData', (paneId, data) => {
    sendForPane(paneId, IPC.paneData, paneId, data);
  });
  ptyManager.on('paneStatus', (sessionId, paneId, pane) => {
    sendForSession(sessionId, IPC.paneStatus, sessionId, paneId, pane);
  });
  ptyManager.on('sessionUpdate', (session) => {
    sendForSession(session.id, IPC.sessionUpdate, session);
  });
  ptyManager.on('urlsDetected', (paneId, urls) => {
    sendForPane(paneId, IPC.urlsDetected, paneId, urls);
  });

  // paneStats arrive en batch (samples = PaneStatSample[] avec paneIds variés) —
  // peut couvrir des panes de plusieurs sessions/windows. Throttle 1s côté IPC
  // pour ne pas saturer (pty-stats émet déjà à ~1Hz mais on prend la marge si
  // un futur path l'accélère). Note : on broadcast pour simplicité ; le payload
  // est petit (≤ N panes × ~50 bytes).
  const sendPaneStats = throttle<PaneStatSample[]>(500, (samples) => {
    safeSend(IPC.paneStats, samples);
  });
  ptyStats.on('stats', (samples) => {
    sendPaneStats(samples);
  });
  // systemStats = stats machine globales, identiques pour toutes les windows.
  // Throttle 1s : l'UI affiche un graphe lissé, pas besoin de plus.
  const sendSystemStats = throttle<SystemStatsSample>(1000, (sample) => {
    safeSend(IPC.systemStats, sample);
  });
  ptyStats.on('systemStats', (sample) => {
    sendSystemStats(sample);
  });

  ptyManager.on('paneAttention', (paneId, level) => {
    sendForPane(paneId, IPC.paneAttention, paneId, level);
    notifService.notifyAttention(paneId, level);
  });
  ptyManager.on('paneAgentState', (paneId, state) => {
    sendForPane(paneId, IPC.paneAgentState, paneId, state);
  });
  ptyManager.on('eventDetected', (event: DetectedEvent) => {
    sendForPane(event.paneId, IPC.eventDetected, event);
    notifService.notifyEvent(event);
  });

  // ---------- Git ----------
  handleResult(IPC.gitInspect, (_e, p: unknown) => {
    const resolved = safePath(p);
    if (!resolved) throw new Error('invalid path');
    return inspectRepo(resolved);
  });
  handle(IPC.gitListWorktrees, (_e, p: unknown) => {
    const resolved = safePath(p);
    if (!resolved) return [];
    return listWorktrees(resolved);
  });

  // ---------- Dialog ----------
  handle(IPC.dialogPickDirectory, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const lang = getSettings().language as Lang;
    const r = await dialog.showOpenDialog(w, {
      properties: ['openDirectory', 'createDirectory'],
      title: notifBundle(lang).dialogPickDirectory
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle(IPC.dialogPickRepo, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const lang = getSettings().language as Lang;
    const r = await dialog.showOpenDialog(w, {
      properties: ['openDirectory'],
      title: notifBundle(lang).dialogPickRepo
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle(IPC.dialogPickSoundFile, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const lang = getSettings().language as Lang;
    const r = await dialog.showOpenDialog(w, {
      properties: ['openFile'],
      title: notifBundle(lang).dialogPickSound,
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a'] }]
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle(IPC.dialogOpenExternal, (_e, url: unknown) => {
    if (!isHttpUrl(url)) return;
    void shell.openExternal(url);
  });

  // ---------- FS ----------
  handle(IPC.fsIsDirectory, async (_e, p: unknown) => {
    const resolved = safePath(p);
    if (!resolved) return false;
    try {
      const st = await fsp.stat(resolved);
      return st.isDirectory();
    } catch {
      return false;
    }
  });

  // ---------- Clipboard ----------
  handle(IPC.clipboardRead, () => clipboard.readText());
  handle(IPC.clipboardWrite, (_e, text: unknown) => {
    if (typeof text !== 'string') return;
    // Bound : éviter qu'un renderer compromis ne push un payload géant dans
    // le clipboard système.
    if (text.length > MAX_CLIPBOARD_LEN) return;
    clipboard.writeText(text);
  });
  handle<ClipboardRichResult>(IPC.clipboardReadRich, async () => {
    // Image dans le clipboard (capture d'écran, copie depuis explorateur, etc.)
    // → on la sauve en PNG temporaire et on renvoie le chemin pour que l'agent
    // puisse la lire (utile pour Claude Code, Codex, etc. qui supportent les pièces jointes).
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      try {
        const png = img.toPNG();
        const ts = Date.now();
        const tmpPath = path.join(os.tmpdir(), `vmux-paste-${ts}.png`);
        await fsp.writeFile(tmpPath, png);
        return { kind: 'image', path: tmpPath };
      } catch (err) {
        log.error('[clipboard] save image failed', err);
      }
    }
    return { kind: 'text', text: clipboard.readText() };
  });

  // ---------- Settings ----------
  handle(IPC.settingsGet, () => getSettings());
  handle(IPC.settingsSet, (_e, raw: unknown) => {
    // Sanitize : whitelist allowed keys, drop __proto__/constructor, drop anything
    // qu'on n'a pas explicitement déclaré dans AppSettings. Sans ça un renderer
    // compromis pourrait pousser une clé arbitraire dans electron-conf.
    const patch = sanitizeSettingsPatch(raw);
    const next = updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'autoLaunch')) {
      syncAutoLaunch(next.autoLaunch);
    }
    return next;
  });

  // ---------- Snippets ----------
  handle(IPC.snippetsList, () => listSnippets());
  handle(IPC.snippetsSave, (_e, s: unknown) => {
    if (!isValidSnippet(s)) throw new Error('invalid snippet');
    return saveSnippet(s);
  });
  handle(IPC.snippetsDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return listSnippets();
    return deleteSnippet(id);
  });

  // ---------- MCP servers ----------
  handleResult(IPC.mcpList, () => mcpList());
  handleResult(IPC.mcpAdd, (_e, s: unknown) => {
    if (!isValidMcpServer(s)) throw new Error('invalid mcp server');
    return mcpAdd(s);
  });
  handleResult(IPC.mcpRemove, (_e, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0 || name.length > 80) {
      throw new Error('invalid mcp name');
    }
    return mcpRemove(name);
  });
  handleResult(IPC.mcpToggle, (_e, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0 || name.length > 80) {
      throw new Error('invalid mcp name');
    }
    return mcpToggle(name);
  });
  handle(IPC.mcpConfigPath, () => mcpConfigPath());

  // ---------- Diagnostic ----------
  handleResult<string | null>(IPC.diagnosticExport, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const lang = getSettings().language as Lang;
    const r = await dialog.showSaveDialog(w, {
      title: notifBundle(lang).dialogExportDiagnostic,
      defaultPath: defaultDiagnosticFilename(),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return null;
    await saveDiagnosticTo(r.filePath);
    void shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
}
