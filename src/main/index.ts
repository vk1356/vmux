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

  // Auto-update (electron-updater) — actif uniquement en prod et si une release
  // GitHub est configurée. Échec silencieux sinon (pas d'app-update.yml = no-op).
  if (!is.dev) {
    void setupAutoUpdater();
  }

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

/** Configure electron-updater. Tolérant aux erreurs : ne crash jamais l'app.
 *  Pousse l'état (checking/available/downloading/downloaded/error) au renderer
 *  via IPC.updateStatus pour qu'il affiche une bannière. */
async function setupAutoUpdater(): Promise<void> {
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    // On préfère installer manuellement via le bouton "Installer et redémarrer".
    autoUpdater.autoInstallOnAppQuit = false;

    const send = (status: import('@shared/types').UpdateStatus): void => {
      const w = mainWindow;
      if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
      w.webContents.send(IPC.updateStatus, status);
    };

    autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      send({
        kind: 'available',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
      })
    );
    autoUpdater.on('update-not-available', (info) =>
      send({ kind: 'not-available', currentVersion: info.version })
    );
    autoUpdater.on('download-progress', (p) =>
      send({
        kind: 'downloading',
        percent: p.percent,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      })
    );
    autoUpdater.on('update-downloaded', (info) =>
      send({
        kind: 'downloaded',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
      })
    );
    autoUpdater.on('error', (err) => send({ kind: 'error', message: err.message }));

    // IPC handlers : déclenche check/download/install depuis le renderer.
    const { ipcMain } = await import('electron');
    ipcMain.handle(IPC.updateCheck, async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        log.warn('[updater] manual check failed', err);
        send({ kind: 'error', message: (err as Error).message });
      }
    });
    ipcMain.handle(IPC.updateDownload, async () => {
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        log.warn('[updater] download failed', err);
        send({ kind: 'error', message: (err as Error).message });
      }
    });
    ipcMain.handle(IPC.updateInstall, () => {
      // quitAndInstall(true, true) : silencieux + redémarre l'app après install.
      autoUpdater.quitAndInstall(true, true);
    });

    // Check 5s après boot pour ne pas bloquer le first paint.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log.info('[updater] check failed (probably no app-update.yml in dev/portable)', err.message);
      });
    }, 5000);

    // Re-check toutes les 4 heures.
    setInterval(
      () => {
        autoUpdater.checkForUpdates().catch((err) => {
          log.debug('[updater] periodic check failed', err.message);
        });
      },
      4 * 60 * 60 * 1000
    );
  } catch (err) {
    log.warn('[updater] setup failed', err);
  }
}

process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection', reason);
});
