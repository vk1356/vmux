import { app, BrowserWindow, session } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from 'electron-log/main';
import { registerIpc } from './ipc';
import { ptyManager } from './pty-manager';
import { IPC } from '@shared/types';
import {
  getGracefulShutdown,
  getSettings,
  setGracefulShutdown
} from './settings-store';
import { cleanupPasteTempFiles } from './temp-cleanup';
import { parseCliArgs, CLI_HELP, type CliCommand } from './cli-args';
import { createWindow, ensureDevShortcutForNotifications, syncAutoLaunch } from './window';
import { setupAutoUpdater, stopAutoUpdater } from './auto-updater';

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = is.dev ? 'debug' : 'warn';

let mainWindow: BrowserWindow | null = null;

// Single-instance lock : si une autre instance tourne déjà, on focus la
// première et on quit pour éviter de corrompre l'electron-conf partagé.
const gotLock = app.requestSingleInstanceLock({ argv: process.argv });
if (!gotLock) {
  app.quit();
}
app.on('second-instance', (_event, _argv, _wd, additionalData) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const data = additionalData as { argv?: string[] } | undefined;
  if (data?.argv) {
    const cmd = parseCliArgs(data.argv);
    void executeCliCommand(cmd);
  }
});

/** Argv de l'instance courante — peut contenir une commande à exécuter au boot. */
const initialCliCommand: CliCommand = parseCliArgs(process.argv);
if (initialCliCommand.kind === 'help') {
  process.stdout.write(CLI_HELP);
  app.quit();
}

/** Exécute une commande CLI une fois l'app prête. */
async function executeCliCommand(cmd: CliCommand): Promise<void> {
  if (cmd.kind === 'none' || cmd.kind === 'help' || cmd.kind === 'hidden') return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (cmd.kind === 'focus') return;

  const path = await import('node:path');
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
    const w = mainWindow;
    if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
      w.webContents.send(IPC.sessionUpdate, session);
    }
  } catch (err) {
    log.error('[cli] failed to create session', err);
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.vmux.app');
  await ensureDevShortcutForNotifications('com.vmux.app');
  app.on('browser-window-created', (_e, w) => {
    optimizer.watchWindowShortcuts(w);
  });

  // CSP renforcée en prod (le dev a besoin de unsafe-inline pour le HMR).
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
  try {
    syncAutoLaunch(getSettings().autoLaunch);
  } catch (err) {
    log.warn('[autolaunch] initial sync failed', err);
  }

  mainWindow = createWindow({ startHidden: initialCliCommand.kind === 'hidden' });

  // Auto-restore des PTY : relance les sessions qui tournaient au shutdown
  // précédent. Différé de 1.2s pour laisser le renderer s'attacher aux events
  // sessionUpdate / paneStatus — sinon l'UI raterait les premiers status.
  if (getSettings().autoRestoreOnBoot) {
    setTimeout(() => {
      void ptyManager.autoRestoreSessions().then((n) => {
        if (n > 0) log.info(`[main] auto-restored ${n} pane(s)`);
      });
    }, 1200);
  }

  // Nettoyage des fichiers temp paste > 24h (en background, non bloquant).
  void cleanupPasteTempFiles();

  // Détection de crash : si le flag gracefulShutdown est false au boot, c'est
  // que l'app est crashée précédemment sans pouvoir le set.
  if (!getGracefulShutdown()) {
    log.warn('[main] crash detected — previous shutdown was not graceful');
  }
  setGracefulShutdown(false);

  // Auto-update — IPC handlers toujours enregistrés pour que l'UI ne reste
  // jamais bloquée sur "Checking…".
  void setupAutoUpdater(() => mainWindow);

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
    stopAutoUpdater();
    await ptyManager.shutdown();
    // 500ms : ConPTY/node-pty Windows mettent ~200-400ms à terminer proprement.
    setTimeout(() => app.exit(0), 500);
  }
});

process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection', reason);
});
