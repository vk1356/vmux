import { app, BrowserWindow, screen, session, shell } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import path from 'node:path';
import log from 'electron-log/main';
import { registerIpc } from './ipc';
import { ptyManager } from './pty-manager';
import { IPC, type WindowState } from '@shared/types';
import {
  getGracefulShutdown,
  getWindowState,
  saveWindowState,
  setGracefulShutdown
} from './settings-store';
import { cleanupPasteTempFiles } from './temp-cleanup';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = is.dev ? 'debug' : 'warn';

let mainWindow: BrowserWindow | null = null;

// Single-instance lock : si une autre instance tourne déjà, on focus la
// première et on quit pour éviter de corrompre l'electron-store partagé.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/** Vérifie que les bounds sauvegardés sont toujours sur un écran connecté. */
function clampToScreens(state: WindowState): WindowState {
  const displays = screen.getAllDisplays();
  if (state.x === undefined || state.y === undefined) return state;
  const fits = displays.some((d) => {
    const a = d.workArea;
    return (
      state.x! >= a.x - 50 &&
      state.y! >= a.y - 50 &&
      state.x! + state.width <= a.x + a.width + 50 &&
      state.y! + state.height <= a.y + a.height + 50
    );
  });
  return fits ? state : { width: state.width, height: state.height, isMaximized: state.isMaximized };
}

function createWindow(): BrowserWindow {
  const saved = clampToScreens(getWindowState());
  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'vMux',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Active le tag <webview> pour les preview panes (process isolé).
      webviewTag: true
    }
  });

  win.on('ready-to-show', () => {
    if (saved.isMaximized) win.maximize();
    win.show();
  });
  win.on('maximize', () => win.webContents.send(IPC.windowMaximizedChanged, true));
  win.on('unmaximize', () => win.webContents.send(IPC.windowMaximizedChanged, false));

  // Persistance taille/position fenêtre — debouncée pour éviter trop d'écritures.
  let saveTimer: NodeJS.Timeout | null = null;
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const isMax = win.isMaximized();
      const bounds = isMax ? win.getNormalBounds() : win.getBounds();
      saveWindowState({ ...bounds, isMaximized: isMax });
    }, 200);
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.vmux.app');
  app.on('browser-window-created', (_e, w) => {
    optimizer.watchWindowShortcuts(w);
  });

  // CSP renforcée en prod (le dev a besoin de unsafe-inline pour le HMR).
  // On l'injecte via header HTTP plutôt que <meta> car c'est plus strict.
  if (!is.dev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
              "script-src 'self'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob:; " +
              "font-src 'self'; " +
              "connect-src 'self'; " +
              "frame-src 'self' http://localhost:* http://127.0.0.1:*; " +
              "child-src 'self' http://localhost:* http://127.0.0.1:*"
          ]
        }
      });
    });
  }

  registerIpc(() => mainWindow);

  mainWindow = createWindow();

  // Nettoyage des fichiers temp paste > 24h (en background, non bloquant).
  void cleanupPasteTempFiles();

  // Détection de crash : si le flag gracefulShutdown est false au boot, c'est
  // que l'app est crashée précédemment sans pouvoir le set. On peut afficher
  // un toast côté renderer plus tard. Ici on log juste.
  if (!getGracefulShutdown()) {
    log.warn('[main] crash detected — previous shutdown was not graceful');
  }
  setGracefulShutdown(false);

  // Auto-update — IPC handlers toujours enregistrés pour que l'UI ne reste
  // jamais bloquée sur "Checking…".
  void setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  await ptyManager.shutdown();
  setGracefulShutdown(true);
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting) return;
  const hasActive = ptyManager.list().some((s) =>
    Object.values(s.panes).some(
      (p) => p.kind === 'terminal' && (p.status === 'running' || p.status === 'starting')
    )
  );
  if (hasActive) {
    event.preventDefault();
    quitting = true;
    log.info('[main] graceful shutdown — killing PTYs');
    await ptyManager.shutdown();
    setTimeout(() => app.exit(0), 80);
  }
});

/**
 * Stratégie auto-update :
 * - Check primaire = API GitHub direct (rapide, fiable, fonctionne en dev).
 *   Timeout dur 8s via AbortController. Compare app.getVersion() vs tag_name.
 * - electron-updater n'est utilisé QUE pour le download différentiel via
 *   blockmap quand l'user clique "Download".
 * - Tous les paths d'erreur envoient un statut UpdateStatus avec un `code`
 *   traduisible côté renderer.
 */
async function setupAutoUpdater(): Promise<void> {
  const { ipcMain } = await import('electron');

  const send = (status: import('@shared/types').UpdateStatus): void => {
    const w = mainWindow;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(IPC.updateStatus, status);
  };

  let lastSentStatus: import('@shared/types').UpdateStatus['kind'] = 'idle';
  const sendStatus = (s: import('@shared/types').UpdateStatus): void => {
    lastSentStatus = s.kind;
    send(s);
  };

  const REPO = 'vk1356/vmux';
  type GhRelease = {
    tag_name: string;
    name?: string;
    body?: string;
    assets?: { name: string; browser_download_url: string }[];
  };

  /** Fetch JSON avec timeout dur via AbortController. Throw en cas d'erreur. */
  async function ghFetchLatest(timeoutMs = 8000): Promise<{
    version: string;
    notes?: string;
    installerUrl?: string;
  }> {
    log.info(`[updater] fetch https://api.github.com/repos/${REPO}/releases/latest (timeout=${timeoutMs}ms)`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'vMux-updater'
        },
        signal: ctrl.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `GitHub API ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`
        );
      }
      const data = (await res.json()) as GhRelease;
      const version = (data.tag_name || '').replace(/^v/, '');
      if (!version) throw new Error('Empty tag_name in GitHub release');
      const installer = data.assets?.find(
        (a) => /Setup.*\.exe$/i.test(a.name) && !a.name.endsWith('.blockmap')
      );
      log.info(`[updater] latest tag=${version} installer=${installer?.name ?? 'none'}`);
      return {
        version,
        notes: data.body,
        installerUrl: installer?.browser_download_url
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function isNewer(remote: string, local: string): boolean {
    const parse = (v: string): number[] =>
      v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const r = parse(remote);
    const l = parse(local);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const a = r[i] ?? 0;
      const b = l[i] ?? 0;
      if (a > b) return true;
      if (a < b) return false;
    }
    return false;
  }

  /** Check primaire : API GitHub. Aucun hang possible (timeout 8s strict).
   *  Envoie 'checking' immédiatement, puis 'available' / 'not-available' / 'error'. */
  async function checkUpdates(): Promise<void> {
    log.info('[updater] checkUpdates() called');
    sendStatus({ kind: 'checking' });
    const local = app.getVersion();
    try {
      const latest = await ghFetchLatest();
      log.info(`[updater] local=${local} remote=${latest.version}`);
      if (isNewer(latest.version, local)) {
        sendStatus({
          kind: 'available',
          version: latest.version,
          releaseNotes: latest.notes
        });
      } else {
        sendStatus({ kind: 'not-available', currentVersion: local });
      }
    } catch (err) {
      const e = err as Error;
      const msg =
        e.name === 'AbortError'
          ? 'Request timed out (8s) — check your connection or proxy'
          : e.message;
      log.warn('[updater] check failed', msg);
      sendStatus({
        kind: 'error',
        code: 'github-api-failed',
        message: msg
      });
    }
  }

  // Handler check : toujours dispo (dev + prod).
  ipcMain.handle(IPC.updateCheck, () => checkUpdates());

  // Mode dev : pas d'electron-updater (pas d'app-update.yml). Download =
  // ouvre l'installer dans le browser. Install = no-op explicite.
  if (is.dev) {
    log.info('[updater] dev mode — no electron-updater, browser download fallback');
    ipcMain.handle(IPC.updateDownload, async () => {
      try {
        const latest = await ghFetchLatest();
        if (latest.installerUrl) {
          await shell.openExternal(latest.installerUrl);
        } else {
          sendStatus({
            kind: 'error',
            code: 'no-installer-url',
            message: 'Installer URL not found in latest release.'
          });
        }
      } catch (err) {
        sendStatus({
          kind: 'error',
          code: 'github-api-failed',
          message: (err as Error).message
        });
      }
    });
    ipcMain.handle(IPC.updateInstall, () => {
      sendStatus({
        kind: 'error',
        code: 'dev-mode',
        message: 'Available only in the installed app, not in dev mode.'
      });
    });
    setTimeout(() => void checkUpdates(), 3000);
    return;
  }

  // Mode prod : electron-updater pour le download différentiel via blockmap.
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('download-progress', (p) =>
      sendStatus({
        kind: 'downloading',
        percent: p.percent,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      })
    );
    autoUpdater.on('update-downloaded', (info) =>
      sendStatus({
        kind: 'downloaded',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
      })
    );
    autoUpdater.on('error', (err) => {
      log.warn('[updater] electron-updater event error', err.message);
    });

    ipcMain.handle(IPC.updateDownload, async () => {
      try {
        log.info('[updater] electron-updater downloadUpdate()');
        // checkForUpdates est nécessaire avant downloadUpdate sinon le metadata
        // n'est pas chargé. On l'enrobe d'un timeout court.
        const checkPromise = autoUpdater.checkForUpdates();
        await Promise.race([
          checkPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('check timeout (10s)')), 10000)
          )
        ]);
        await autoUpdater.downloadUpdate();
      } catch (err) {
        log.warn('[updater] downloadUpdate failed, falling back to browser', err);
        try {
          const latest = await ghFetchLatest();
          if (latest.installerUrl) {
            await shell.openExternal(latest.installerUrl);
          } else {
            sendStatus({
              kind: 'error',
              code: 'no-installer-url',
              message: 'Installer URL not found in latest release.'
            });
          }
        } catch (err2) {
          sendStatus({
            kind: 'error',
            code: 'github-api-failed',
            message: (err2 as Error).message
          });
        }
      }
    });

    ipcMain.handle(IPC.updateInstall, () => {
      if (lastSentStatus !== 'downloaded') {
        sendStatus({
          kind: 'error',
          code: 'install-no-download',
          message:
            'Download not completed through electron-updater — re-run download or install manually.'
        });
        return;
      }
      autoUpdater.quitAndInstall(true, true);
    });

    // Premier check 3s après boot (laisse le first paint respirer).
    setTimeout(() => void checkUpdates(), 3000);

    // Re-check toutes les 4 heures.
    setInterval(() => void checkUpdates(), 4 * 60 * 60 * 1000);
  } catch (err) {
    log.warn('[updater] electron-updater unavailable', err);
    // Fallback complet : download = browser, install = error explicite.
    ipcMain.handle(IPC.updateDownload, async () => {
      try {
        const latest = await ghFetchLatest();
        if (latest.installerUrl) await shell.openExternal(latest.installerUrl);
      } catch (err2) {
        sendStatus({
          kind: 'error',
          code: 'github-api-failed',
          message: (err2 as Error).message
        });
      }
    });
    ipcMain.handle(IPC.updateInstall, () => {
      sendStatus({
        kind: 'error',
        code: 'install-no-download',
        message: 'electron-updater unavailable — install manually.'
      });
    });
    setTimeout(() => void checkUpdates(), 3000);
  }
}

process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection', reason);
});
