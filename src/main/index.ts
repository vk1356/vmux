import { app, BrowserWindow, screen, session, shell } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import log from 'electron-log/main';
import { registerIpc } from './ipc';
import { ptyManager } from './pty-manager';
import { IPC, type WindowState } from '@shared/types';
import {
  getGracefulShutdown,
  getSettings,
  getWindowState,
  saveWindowState,
  setGracefulShutdown
} from './settings-store';
import { cleanupPasteTempFiles } from './temp-cleanup';
import { parseCliArgs, CLI_HELP, type CliCommand } from './cli-args';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = is.dev ? 'debug' : 'warn';

let mainWindow: BrowserWindow | null = null;

// Single-instance lock : si une autre instance tourne déjà, on focus la
// première et on quit pour éviter de corrompre l'electron-store partagé.
// On passe argv via additionalData pour que l'instance principale puisse
// traiter les commandes CLI envoyées par les exe lancés ensuite.
const gotLock = app.requestSingleInstanceLock({ argv: process.argv });
if (!gotLock) {
  app.quit();
}
app.on('second-instance', (_event, _argv, _wd, additionalData) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // Récupère argv passé par l'instance secondaire et exécute la commande.
  const data = additionalData as { argv?: string[] } | undefined;
  if (data?.argv) {
    const cmd = parseCliArgs(data.argv);
    void executeCliCommand(cmd);
  }
});

/** Argv de l'instance courante — peut contenir une commande à exécuter au boot
 *  (ex: si l'user lance vMux.exe new --agent claude depuis un terminal et
 *  qu'aucune instance n'est encore active). */
const initialCliCommand: CliCommand = parseCliArgs(process.argv);
if (initialCliCommand.kind === 'help') {
  // Print l'aide sur stdout et quitte. NB : sur une app GUI Windows, stdout
  // n'est visible que si lancée depuis un cmd avec `vMux.exe help`.
  process.stdout.write(CLI_HELP);
  app.quit();
}

/** Exécute une commande CLI une fois l'app prête. Crée une session via
 *  ptyManager si kind='new'. Idempotent : focus la window dans tous les cas. */
async function executeCliCommand(cmd: CliCommand): Promise<void> {
  if (cmd.kind === 'none' || cmd.kind === 'help' || cmd.kind === 'hidden') return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (cmd.kind === 'focus') return;

  const cwd = cmd.cwd ?? process.cwd();
  const name = cmd.name ?? (path.basename(cwd) || 'session');
  log.info(`[cli] new session: agent=${cmd.agentId} cwd=${cwd} name=${name}`);
  try {
    const session = await ptyManager.createSession({
      name,
      agentId: cmd.agentId,
      cwd,
      initialInput: cmd.prompt
    });
    // Notifie le renderer que la session existe pour qu'il l'active.
    const w = mainWindow;
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
      w.webContents.send(IPC.sessionUpdate, session);
    }
  } catch (err) {
    log.error('[cli] failed to create session', err);
  }
}

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
    minWidth: 560,
    minHeight: 420,
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
    // Si vMux est lancé avec --hidden (auto-launch Windows), on ne montre pas
    // la window — l'user peut la rouvrir via le tray ou la barre des tâches.
    if (initialCliCommand.kind !== 'hidden') {
      win.show();
    }
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

/**
 * En dev, Windows ne livre pas les toasts natifs si l'AppUserModel.ID n'est
 * pas associé à un raccourci dans le Start Menu. En prod, electron-builder
 * pose automatiquement le bon AUMID sur le `.lnk` créé par NSIS — donc rien
 * à faire. Pour le dev mode, on génère un raccourci `vMux (Dev).lnk` une
 * seule fois via PowerShell. Idempotent : si le fichier existe déjà, on skip.
 *
 * Échec silencieux : si PowerShell est bloqué (ExecPolicy, AV…), on continue
 * — les notifs ne marcheront pas en dev mais l'app fonctionne quand même.
 */
async function ensureDevShortcutForNotifications(aumid: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!is.dev) return;
  const startMenu = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs'
  );
  const shortcutPath = path.join(startMenu, 'vMux (Dev).lnk');
  try {
    await fs.promises.mkdir(startMenu, { recursive: true });
    if (fs.existsSync(shortcutPath)) return;
    // Script PowerShell : crée un .lnk avec WScript.Shell + définit la
    // propriété System.AppUserModel.ID (PKEY 9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3).
    // C'est le pattern documenté par Microsoft pour associer l'AUMID au shortcut.
    const exe = process.execPath;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$ws = New-Object -ComObject WScript.Shell`,
      `$shortcut = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
      `$shortcut.TargetPath = '${exe.replace(/'/g, "''")}'`,
      `$shortcut.IconLocation = '${exe.replace(/'/g, "''")}'`,
      `$shortcut.Save()`
    ].join('; ');
    await new Promise<void>((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true }
      );
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
    log.info(`[notif] dev shortcut prepared at ${shortcutPath} (aumid=${aumid})`);
  } catch (err) {
    log.warn('[notif] dev shortcut creation failed (notifs may not appear in dev)', err);
  }
}

/** Synchronise `app.setLoginItemSettings` avec la valeur du setting autoLaunch.
 *  En dev mode on ne touche à rien (le path est electron.exe, pas vMux.exe). */
function syncAutoLaunch(enabled: boolean): void {
  if (process.platform !== 'win32') return;
  if (is.dev) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--hidden']
    });
    log.info(`[autolaunch] openAtLogin=${enabled}`);
  } catch (err) {
    log.warn('[autolaunch] failed to set login item', err);
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.vmux.app');
  await ensureDevShortcutForNotifications('com.vmux.app');
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

  // Au boot, applique l'état d'auto-launch correspondant à la valeur du setting.
  // Ainsi, si l'user re-installe ou si Windows perd l'entrée registry, on reste
  // cohérent. Pas d'effet en dev.
  try {
    syncAutoLaunch(getSettings().autoLaunch);
  } catch (err) {
    log.warn('[autolaunch] initial sync failed', err);
  }

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

  // Exécute la commande CLI initiale si fournie (`vMux.exe new --agent ...`).
  // Délai pour laisser le ready-to-show de la window se déclencher.
  if (initialCliCommand.kind === 'new' || initialCliCommand.kind === 'focus') {
    setTimeout(() => void executeCliCommand(initialCliCommand), 800);
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

  /** Path du dernier installer téléchargé manuellement, prêt à être lancé. */
  let pendingManualInstaller: string | null = null;

  /** Télécharge l'installer NSIS dans le dossier temp avec progress. Renvoie
   *  le path local. Aucun browser ouvert, tout reste dans l'app. */
  async function manualDownloadAndPrepare(
    installerUrl: string,
    version: string
  ): Promise<string> {
    const tmpDir = path.join(app.getPath('temp'), 'vmux-updater');
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `vMux-Setup-${version}.exe`);

    log.info(`[updater] manual download from ${installerUrl} → ${tmpPath}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000); // 10 min max
    try {
      const res = await fetch(installerUrl, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'vMux-updater' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error('Empty response body');

      const total = Number(res.headers.get('content-length') ?? 0);
      let transferred = 0;
      let lastSentTs = 0;
      const startTs = Date.now();

      const nodeStream = Readable.fromWeb(res.body as never);
      nodeStream.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastSentTs > 200) {
          const elapsed = (now - startTs) / 1000;
          sendStatus({
            kind: 'downloading',
            percent: total > 0 ? (transferred / total) * 100 : 0,
            bytesPerSecond: elapsed > 0 ? transferred / elapsed : 0,
            transferred,
            total
          });
          lastSentTs = now;
        }
      });

      await pipeline(nodeStream, fs.createWriteStream(tmpPath));
      log.info(`[updater] download complete: ${tmpPath} (${transferred} bytes)`);
      return tmpPath;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lance l'installer NSIS en silencieux et quitte l'app pour libérer les
   *  file locks. NSIS replace les fichiers et relance vMux à la fin
   *  (runAfterFinish: true configuré dans package.json). */
  function runInstallerAndQuit(installerPath: string): void {
    log.info(`[updater] spawning installer ${installerPath} /S --force-run`);
    try {
      const child = spawn(installerPath, ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch (err) {
      log.error('[updater] failed to spawn installer', err);
      sendStatus({
        kind: 'error',
        code: 'install-no-download',
        message: `Failed to start installer: ${(err as Error).message}`
      });
      return;
    }
    // Petit délai pour laisser le child démarrer avant qu'on libère les locks.
    setTimeout(() => app.exit(0), 800);
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

  // Mode dev : pas d'electron-updater (pas d'app-update.yml). Install = no-op
  // car en dev on ne peut pas remplacer le binaire current.
  if (is.dev) {
    log.info('[updater] dev mode — manual download only, no install');
    ipcMain.handle(IPC.updateDownload, async () => {
      try {
        const latest = await ghFetchLatest();
        if (!latest.installerUrl) {
          sendStatus({
            kind: 'error',
            code: 'no-installer-url',
            message: 'Installer URL not found in latest release.'
          });
          return;
        }
        sendStatus({
          kind: 'downloading',
          percent: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0
        });
        pendingManualInstaller = await manualDownloadAndPrepare(
          latest.installerUrl,
          latest.version
        );
        sendStatus({
          kind: 'downloaded',
          version: latest.version,
          releaseNotes: latest.notes
        });
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
        const checkPromise = autoUpdater.checkForUpdates();
        await Promise.race([
          checkPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('check timeout (10s)')), 10000)
          )
        ]);
        await autoUpdater.downloadUpdate();
        // electron-updater émet 'update-downloaded' → handler global envoie le statut.
        // pendingManualInstaller reste null donc Install utilisera quitAndInstall.
      } catch (err) {
        log.warn('[updater] electron-updater download failed, manual fallback', err);
        // Fallback : download manuel intégré dans l'app, pas de browser.
        try {
          const latest = await ghFetchLatest();
          if (!latest.installerUrl) {
            sendStatus({
              kind: 'error',
              code: 'no-installer-url',
              message: 'Installer URL not found in latest release.'
            });
            return;
          }
          sendStatus({
            kind: 'downloading',
            percent: 0,
            bytesPerSecond: 0,
            transferred: 0,
            total: 0
          });
          pendingManualInstaller = await manualDownloadAndPrepare(
            latest.installerUrl,
            latest.version
          );
          sendStatus({
            kind: 'downloaded',
            version: latest.version,
            releaseNotes: latest.notes
          });
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
      // Cas 1 : download manuel via fallback → spawn /S + quit.
      if (pendingManualInstaller) {
        runInstallerAndQuit(pendingManualInstaller);
        return;
      }
      // Cas 2 : download via electron-updater → quitAndInstall.
      if (lastSentStatus === 'downloaded') {
        log.info('[updater] electron-updater quitAndInstall');
        autoUpdater.quitAndInstall(true, true);
        return;
      }
      sendStatus({
        kind: 'error',
        code: 'install-no-download',
        message:
          'Download not completed — re-run download first.'
      });
    });

    // Premier check 3s après boot (laisse le first paint respirer).
    setTimeout(() => void checkUpdates(), 3000);

    // Re-check toutes les 4 heures.
    setInterval(() => void checkUpdates(), 4 * 60 * 60 * 1000);
  } catch (err) {
    log.warn('[updater] electron-updater unavailable, manual download only', err);
    ipcMain.handle(IPC.updateDownload, async () => {
      try {
        const latest = await ghFetchLatest();
        if (!latest.installerUrl) {
          sendStatus({
            kind: 'error',
            code: 'no-installer-url',
            message: 'Installer URL not found in latest release.'
          });
          return;
        }
        sendStatus({
          kind: 'downloading',
          percent: 0,
          bytesPerSecond: 0,
          transferred: 0,
          total: 0
        });
        pendingManualInstaller = await manualDownloadAndPrepare(
          latest.installerUrl,
          latest.version
        );
        sendStatus({
          kind: 'downloaded',
          version: latest.version,
          releaseNotes: latest.notes
        });
      } catch (err2) {
        sendStatus({
          kind: 'error',
          code: 'github-api-failed',
          message: (err2 as Error).message
        });
      }
    });
    ipcMain.handle(IPC.updateInstall, () => {
      if (pendingManualInstaller) {
        runInstallerAndQuit(pendingManualInstaller);
        return;
      }
      sendStatus({
        kind: 'error',
        code: 'install-no-download',
        message: 'No installer downloaded — re-run download first.'
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
