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
import type { Snippet } from '@shared/types';
import { defaultDiagnosticFilename, saveDiagnosticTo } from './diagnostic';
import { checkAgents } from './agent-check';
import { notifBundle } from '@shared/notif-i18n';
import type { TreePath } from '@shared/tree';
import type { LayoutPreset } from '@shared/layouts';
import { createNotificationService, preloadNotificationIcon } from './notification-service';
import { syncAutoLaunch } from './window';

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

  /** Envoi protégé : ignore si la window est fermée/détruite (évite l'exception
   *  "Object has been destroyed" quand un event ptyManager arrive après quit). */
  const safeSend = (channel: string, ...args: unknown[]): void => {
    const w = getMainWindow();
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, ...args);
  };

  const notifService = createNotificationService(getMainWindow, safeSend);


  // ---------- App ----------
  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  // ---------- Window ----------
  ipcMain.handle(IPC.windowMinimize, () => getMainWindow()?.minimize());
  ipcMain.handle(IPC.windowMaximize, () => {
    const w = getMainWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle(IPC.windowClose, () => getMainWindow()?.close());
  ipcMain.handle(IPC.windowIsMaximized, () => getMainWindow()?.isMaximized() ?? false);

  // ---------- Agents ----------
  ipcMain.handle(IPC.agentsList, () => DEFAULT_AGENTS);
  ipcMain.handle(IPC.agentsCheck, () => checkAgents(DEFAULT_AGENTS));

  // ---------- Sessions ----------
  ipcMain.handle(IPC.sessionList, () => ptyManager.list());
  ipcMain.handle(IPC.sessionCreate, (_e, input: CreateSessionInput) =>
    safe('sessionCreate', () => ptyManager.createSession(input))
  );
  ipcMain.handle(IPC.sessionRemove, (_e, id: string) => ptyManager.removeSession(id));

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
  ipcMain.handle(IPC.paneSetUrl, (_e, sessionId: string, paneId: PaneId, url: string) =>
    ptyManager.setPaneUrl(sessionId, paneId, url)
  );
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
    (_e, sessionId: string, terminalPaneId: PaneId, url: string) =>
      safe('paneOpenPreview', () =>
        ptyManager.splitPane({
          sessionId,
          paneId: terminalPaneId,
          direction: 'horizontal',
          url,
          followsPaneId: terminalPaneId
        })
      )
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
    safeSend(IPC.paneData, paneId, data);
  });
  ptyManager.on('paneStatus', (sessionId, paneId, pane) => {
    safeSend(IPC.paneStatus, sessionId, paneId, pane);
  });
  ptyManager.on('sessionUpdate', (session) => {
    safeSend(IPC.sessionUpdate, session);
  });
  ptyManager.on('urlsDetected', (paneId, urls) => {
    safeSend(IPC.urlsDetected, paneId, urls);
  });
  ptyStats.on('stats', (samples) => {
    safeSend(IPC.paneStats, samples);
  });
  ptyStats.on('systemStats', (sample) => {
    safeSend(IPC.systemStats, sample);
  });
  ptyManager.on('paneAttention', (paneId, level) => {
    safeSend(IPC.paneAttention, paneId, level);
    notifService.notifyAttention(paneId, level);
  });
  ptyManager.on('paneAgentState', (paneId, state) => {
    safeSend(IPC.paneAgentState, paneId, state);
  });
  ptyManager.on('eventDetected', (event: DetectedEvent) => {
    safeSend(IPC.eventDetected, event);
    notifService.notifyEvent(event);
  });

  // ---------- Git ----------
  ipcMain.handle(IPC.gitInspect, (_e, p: string) => safe('gitInspect', () => inspectRepo(p)));
  ipcMain.handle(IPC.gitListWorktrees, (_e, p: string) => listWorktrees(p));

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
  ipcMain.handle(IPC.fsIsDirectory, async (_e, p: string) => {
    if (typeof p !== 'string' || !p) return false;
    try {
      const st = await fsp.stat(p);
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
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<import('@shared/types').AppSettings>) => {
    const next = updateSettings(patch);
    // Si autoLaunch a changé dans ce patch, applique le LoginItemSetting via
    // le helper centralisé (dédupliqué — la logique vivait à 2 endroits).
    if (Object.prototype.hasOwnProperty.call(patch, 'autoLaunch')) {
      syncAutoLaunch(next.autoLaunch);
    }
    return next;
  });

  // ---------- Snippets ----------
  ipcMain.handle(IPC.snippetsList, () => listSnippets());
  ipcMain.handle(IPC.snippetsSave, (_e, s: Snippet) => saveSnippet(s));
  ipcMain.handle(IPC.snippetsDelete, (_e, id: string) => deleteSnippet(id));

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

