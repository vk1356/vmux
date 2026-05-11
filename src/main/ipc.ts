import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IPC,
  type ClipboardRichResult,
  type CreateSessionInput,
  type DetectedEvent,
  type IpcResult,
  type Lang,
  type PaneId,
  type PtySize,
  type SplitPaneInput
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
    o.rows > 0
  );
}

// ============================================================
// Validation helpers (IPC boundary = security perimeter)
// ============================================================

/** Rejette une string qui contient un NUL byte, des séquences traversantes
 *  ou des préfixes Windows dangereux. */
function isUnsafePath(p: unknown): p is unknown {
  if (typeof p !== 'string' || !p) return true;
  if (p.length > 4096) return true;
  if (p.indexOf('\0') !== -1) return true;
  if (process.platform === 'win32') {
    // \\server\share, \\.\device, \\?\
    if (p.startsWith('\\\\')) return true;
    // /dev/ etc. n'existe pas sur Windows mais on les rejette quand même.
    if (/^\/+(?:dev|proc|sys)\//i.test(p)) return true;
  }
  return false;
}

/** Validation stricte d'URL http(s) côté IPC — bloque javascript:/file:/data:/etc. */
function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 4096) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  // Refuse les NUL et autres ctrl chars qui peuvent masquer le scheme.
  if (/[\x00-\x1f\x7f]/.test(u)) return false;
  return true;
}

/** Liste blanche des clés AppSettings — empêche les attaques prototype-pollution
 *  (`__proto__`, `constructor`, `prototype`) et la fuite de clés inconnues vers
 *  electron-conf. */
const ALLOWED_SETTINGS_KEYS = new Set<string>([
  'theme', 'language', 'fontFamily', 'fontSize', 'defaultShell', 'scrollback',
  'cursorBlink', 'copyOnSelection', 'pasteOnRightClick', 'webglRenderer',
  'sidebarWidth', 'previewToastEnabled', 'previewAutoOpen', 'notificationsEnabled',
  'notificationSound', 'notificationSoundPath', 'autoLaunch', 'previewDefaultSplit',
  'agentOverrides', 'onboardingCompleted', 'autoRestoreOnBoot',
  'lastActiveSessionId', 'cdpEnabled', 'cdpPort', 'claudeCommandsEnabled'
]);

function sanitizeSettingsPatch(patch: unknown): Partial<import('@shared/types').AppSettings> {
  if (!patch || typeof patch !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (!ALLOWED_SETTINGS_KEYS.has(k)) continue;
    out[k] = (patch as Record<string, unknown>)[k];
  }
  return out as Partial<import('@shared/types').AppSettings>;
}

/** Validation structurelle d'un McpServer venu du renderer. Le command/args/env
 *  ne sont pas filtrés sémantiquement (l'user peut légitimement configurer
 *  n'importe quel serveur MCP) mais on vérifie shape/limites pour éviter qu'un
 *  bug renderer écrive du JSON corrompu dans `~/.claude.json`. */
function isValidMcpServer(s: unknown): s is import('@shared/types').McpServer {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 80) return false;
  if (o.name.indexOf('\0') !== -1 || /[\/\\]/.test(o.name)) return false;
  if (o.type !== 'stdio' && o.type !== 'http' && o.type !== 'sse') return false;
  if (o.command !== undefined) {
    if (typeof o.command !== 'string' || o.command.length > 2048) return false;
    if (o.command.indexOf('\0') !== -1) return false;
  }
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.length > 64) return false;
    for (const a of o.args) {
      if (typeof a !== 'string' || a.length > 4096 || a.indexOf('\0') !== -1) return false;
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
      if (typeof v !== 'string' || v.length > 4096 || v.indexOf('\0') !== -1) return false;
    }
  }
  if (o.url !== undefined) {
    if (typeof o.url !== 'string' || o.url.length > 4096) return false;
    if (o.type !== 'stdio' && !isHttpUrl(o.url)) return false;
  }
  if (o.disabled !== undefined && typeof o.disabled !== 'boolean') return false;
  return true;
}

function isValidSnippet(s: unknown): s is import('@shared/types').Snippet {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 128) return false;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 200) return false;
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

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  // Résolution async de l'icône de notif — non bloquant.
  void preloadNotificationIcon();

  /** Map sessionId → fenêtre détachée. Multi-window : une session peut être
   *  ouverte dans sa propre BrowserWindow en plus de la fenêtre principale.
   *  La Map est nettoyée au close de la window. */
  const detachedWindows = new Map<string, BrowserWindow>();

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


  // ---------- App ----------
  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  // ---------- Window ----------
  // Tous les handlers ciblent la fenêtre **émettrice** (sender) plutôt que la
  // mainWindow : sinon le bouton minimize d'une fenêtre détachée minimiserait
  // la fenêtre principale. Fallback sur mainWindow pour les invocations sans
  // sender utilisable (rare).
  const senderWin = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender) ?? getMainWindow();
  ipcMain.handle(IPC.windowMinimize, (e) => senderWin(e)?.minimize());
  ipcMain.handle(IPC.windowMaximize, (e) => {
    const w = senderWin(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle(IPC.windowClose, (e) => senderWin(e)?.close());
  ipcMain.handle(IPC.windowIsMaximized, (e) => senderWin(e)?.isMaximized() ?? false);

  ipcMain.handle(IPC.windowDetachSession, (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return;
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
    win.on('closed', () => {
      // Nettoie la map seulement si l'entrée pointe encore sur cette window
      // (au cas où une race aurait déjà ré-attribué la slot).
      if (detachedWindows.get(sessionId) === win) {
        detachedWindows.delete(sessionId);
      }
    });
  });

  // ---------- Agents ----------
  ipcMain.handle(IPC.agentsList, () => DEFAULT_AGENTS);
  ipcMain.handle(IPC.agentsCheck, () => checkAgents(DEFAULT_AGENTS));

  // ---------- Sessions ----------
  ipcMain.handle(IPC.sessionList, () => ptyManager.list());
  ipcMain.handle(IPC.sessionCreate, (_e, input: CreateSessionInput) =>
    safe('sessionCreate', () => ptyManager.createSession(input))
  );
  ipcMain.handle(IPC.sessionRemove, async (_e, id: string) => {
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
  ipcMain.handle(IPC.paneSplit, (_e, input: SplitPaneInput) =>
    safe('paneSplit', () => ptyManager.splitPane(input))
  );
  ipcMain.handle(IPC.paneClose, (_e, sessionId: string, paneId: PaneId) =>
    safe('paneClose', () => ptyManager.closePane(sessionId, paneId))
  );
  ipcMain.handle(IPC.paneFocus, (_e, sessionId: string, paneId: PaneId) =>
    ptyManager.focusPane(sessionId, paneId)
  );
  ipcMain.handle(IPC.paneRestart, (_e, sessionId: string, paneId: PaneId) =>
    safe('paneRestart', () => ptyManager.restartPane(sessionId, paneId))
  );
  ipcMain.handle(
    IPC.paneResizeSplit,
    (_e, sessionId: string, splitPath: TreePath, sizes: number[]) =>
      ptyManager.resizeSplit(sessionId, splitPath, sizes)
  );
  ipcMain.handle(IPC.paneSetUrl, (_e, sessionId: unknown, paneId: unknown, url: unknown) => {
    if (typeof sessionId !== 'string' || typeof paneId !== 'string') return;
    // Refuse tout schéma non-http (javascript:, file:, data:…) à la frontière
    // IPC. La validation est aussi appliquée côté <webview> mais il vaut mieux
    // ne JAMAIS persister une URL malicieuse côté main.
    if (!isHttpUrl(url)) return;
    ptyManager.setPaneUrl(sessionId, paneId, url);
  });
  ipcMain.handle(IPC.paneRelayout, (_e, sessionId: string, preset: LayoutPreset) =>
    safe('paneRelayout', () => ptyManager.relayout(sessionId, preset))
  );
  ipcMain.handle(IPC.paneRename, (_e, sessionId: string, paneId: PaneId, label: string) =>
    safe('paneRename', () => ptyManager.renamePane(sessionId, paneId, label))
  );
  ipcMain.handle(
    IPC.paneRemoveUrl,
    (_e, sessionId: string, paneId: PaneId, url: string) =>
      safe('paneRemoveUrl', () => ptyManager.removeUrlFromPane(sessionId, paneId, url))
  );
  ipcMain.handle(IPC.sessionRename, (_e, sessionId: string, name: string) =>
    safe('sessionRename', () => ptyManager.renameSession(sessionId, name))
  );
  ipcMain.handle(IPC.sessionRestartAll, (_e, sessionId: string) =>
    safe('sessionRestartAll', () => ptyManager.restartAll(sessionId))
  );
  ipcMain.handle(IPC.sessionTogglePin, (_e, sessionId: string) =>
    safe('sessionTogglePin', () => ptyManager.togglePin(sessionId))
  );
  ipcMain.handle(IPC.sessionSetColor, (_e, sessionId: string, color: string | null) =>
    safe('sessionSetColor', () => ptyManager.setSessionColor(sessionId, color))
  );
  ipcMain.handle(
    IPC.paneOpenPreview,
    (_e, sessionId: unknown, terminalPaneId: unknown, url: unknown) =>
      safe('paneOpenPreview', () => {
        if (typeof sessionId !== 'string' || typeof terminalPaneId !== 'string') {
          throw new Error('invalid pane');
        }
        if (!isHttpUrl(url)) throw new Error('invalid url');
        return ptyManager.splitPane({
          sessionId,
          paneId: terminalPaneId,
          direction: 'horizontal',
          url,
          followsPaneId: terminalPaneId
        });
      })
  );

  ipcMain.on(IPC.paneWrite, (_e, paneId: unknown, data: unknown) => {
    // Hot path (chaque keystroke) — validation minimale pour rejeter les
    // payloads malformés sans logger (sinon flood des logs en cas de bug).
    if (typeof paneId !== 'string' || typeof data !== 'string') return;
    ptyManager.writePane(paneId, data);
  });
  ipcMain.on(IPC.paneResize, (_e, paneId: unknown, size: unknown) => {
    if (typeof paneId !== 'string' || !isValidPtySize(size)) return;
    ptyManager.resizePane(paneId, size);
  });

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
  // peut couvrir des panes de plusieurs sessions/windows. On broadcast pour
  // simplicité ; le payload est petit (≤ N panes × ~50 bytes).
  ptyStats.on('stats', (samples) => {
    safeSend(IPC.paneStats, samples);
  });
  // systemStats = stats machine globales, identiques pour toutes les windows.
  ptyStats.on('systemStats', (sample) => {
    safeSend(IPC.systemStats, sample);
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
  ipcMain.handle(IPC.gitInspect, (_e, p: unknown) =>
    safe('gitInspect', () => {
      if (isUnsafePath(p)) throw new Error('invalid path');
      return inspectRepo(path.resolve(p as string));
    })
  );
  ipcMain.handle(IPC.gitListWorktrees, (_e, p: unknown) => {
    if (isUnsafePath(p)) return [];
    return listWorktrees(path.resolve(p as string));
  });

  // ---------- Dialog ----------
  ipcMain.handle(IPC.dialogPickDirectory, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const lang = getSettings().language as Lang;
    const r = await dialog.showOpenDialog(w, {
      properties: ['openDirectory', 'createDirectory'],
      title: notifBundle(lang).dialogPickDirectory
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.dialogPickRepo, async () => {
    const w = getMainWindow();
    if (!w) return null;
    const lang = getSettings().language as Lang;
    const r = await dialog.showOpenDialog(w, {
      properties: ['openDirectory'],
      title: notifBundle(lang).dialogPickRepo
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.dialogPickSoundFile, async () => {
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
  ipcMain.handle(IPC.dialogOpenExternal, (_e, url: string) => {
    if (typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    void shell.openExternal(url);
  });

  // ---------- FS ----------
  ipcMain.handle(IPC.fsIsDirectory, async (_e, p: unknown) => {
    if (isUnsafePath(p)) return false;
    try {
      const st = await fsp.stat(path.resolve(p as string));
      return st.isDirectory();
    } catch {
      return false;
    }
  });

  // ---------- Clipboard ----------
  ipcMain.handle(IPC.clipboardRead, () => clipboard.readText());
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.handle(IPC.clipboardReadRich, async (): Promise<ClipboardRichResult> => {
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
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, raw: unknown) => {
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
  ipcMain.handle(IPC.snippetsList, () => listSnippets());
  ipcMain.handle(IPC.snippetsSave, (_e, s: unknown) => {
    if (!isValidSnippet(s)) throw new Error('invalid snippet');
    return saveSnippet(s);
  });
  ipcMain.handle(IPC.snippetsDelete, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return listSnippets();
    return deleteSnippet(id);
  });

  // ---------- MCP servers ----------
  ipcMain.handle(IPC.mcpList, () => safe('mcpList', () => mcpList()));
  ipcMain.handle(IPC.mcpAdd, (_e, s: unknown) =>
    safe('mcpAdd', () => {
      if (!isValidMcpServer(s)) throw new Error('invalid mcp server');
      return mcpAdd(s);
    })
  );
  ipcMain.handle(IPC.mcpRemove, (_e, name: unknown) =>
    safe('mcpRemove', () => {
      if (typeof name !== 'string' || name.length === 0 || name.length > 80) {
        throw new Error('invalid mcp name');
      }
      return mcpRemove(name);
    })
  );
  ipcMain.handle(IPC.mcpToggle, (_e, name: unknown) =>
    safe('mcpToggle', () => {
      if (typeof name !== 'string' || name.length === 0 || name.length > 80) {
        throw new Error('invalid mcp name');
      }
      return mcpToggle(name);
    })
  );
  ipcMain.handle(IPC.mcpConfigPath, () => mcpConfigPath());

  // ---------- Diagnostic ----------
  ipcMain.handle(IPC.diagnosticExport, () =>
    safe('diagnosticExport', async () => {
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
    })
  );
}

