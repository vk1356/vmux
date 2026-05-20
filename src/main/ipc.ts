import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IPC,
  type ClipboardRichResult,
  type DetectedEvent,
  type IpcResult,
  type Lang,
  type PaneStatSample,
  type SystemStatsSample
} from '@shared/types';
import { DEFAULT_AGENTS } from '@shared/agents';
import { ptyManager } from './pty-host-client-singleton';
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
import { createNotificationService, preloadNotificationIcon } from './notification-service';
import { createDetachedWindow, syncAutoLaunch } from './window';
import {
  addServer as mcpAdd,
  getConfigPath as mcpConfigPath,
  listServers as mcpList,
  removeServer as mcpRemove,
  toggleServer as mcpToggle
} from './mcp-manager';
import {
  MAX_CLIPBOARD_LEN,
  MAX_ID_LEN,
  MAX_LABEL_LEN,
  isId,
  isHttpUrl,
  isString,
  isValidCreateSessionInput,
  isValidLayoutPreset,
  isValidMcpServer,
  isValidPtySize,
  isValidSizesArray,
  isValidSnippet,
  isValidSplitPaneInput,
  isValidTreePath,
  safePath,
  sanitizeSettingsPatch
} from './ipc-validation';

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
    // Wire the zero-copy PTY data channel for this detached window too —
    // its renderer needs the same `window.cmux.panes.onData` surface that
    // the main window has, served by a dedicated MessageChannelMain.
    void import('./pty-host-client-singleton').then(({ getPaneDataChannelManager }) => {
      getPaneDataChannelManager()?.attachWindow(win);
    });
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

  // paneData: forward bytes from PTY Host → renderer via main-process IPC.
  // The Phase-2 MessagePort transport (transferred MessagePortMain) is wired
  // and ready to take over, but in Electron 42 our ArrayBuffer messages were
  // silently dropped on the host side — falling back to structured-clone IPC
  // here so the terminal actually shows output. The renderer accepts both
  // paths (preload feeds them into the same paneDataDispatcher).
  ptyManager.on('paneData', (paneId: string, data: Uint8Array) => {
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
