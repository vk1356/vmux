import { app, BrowserWindow, session, shell } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from 'electron-log/main';
import { registerIpc } from './ipc';
import { ptyManager } from './pty-host-client-singleton';
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
import { installClaudeOrchestrateCommand } from './claude-commands';

// ---------------------------------------------------------------------------
// Process-level error trapping — registered FIRST so it catches failures that
// happen before/during `whenReady()`. electron-log is safe pre-init for these
// channels (it falls back to console.error until `log.initialize()` runs).
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  log.error('[main] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('[main] unhandledRejection', reason);
});

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = is.dev ? 'debug' : 'warn';

const APP_USER_MODEL_ID = 'com.vmux.app';

// Chrome DevTools Protocol bridge — must be applied BEFORE the first BrowserWindow
// is created (otherwise the switch is ignored). Allows `chrome-devtools-mcp`
// (Claude Code, Codex CLI, etc.) to drive embedded <webview>s in vMux — click,
// type, a11y snapshots, JS eval. Synchronous setting read via electron-conf;
// defaults to ON on port 9222.
try {
  const { cdpEnabled, cdpPort } = getSettings();
  if (cdpEnabled && Number.isInteger(cdpPort) && cdpPort > 0 && cdpPort < 65536) {
    app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
    log.info(`[cdp] DevTools Protocol enabled on localhost:${cdpPort}`);
  } else {
    log.info('[cdp] disabled');
  }
} catch (err) {
  log.warn('[cdp] failed to apply remote-debugging-port', err);
}

let mainWindow: BrowserWindow | null = null;

// Single-instance lock — bail early if another instance already holds it so
// we never even reach `app.whenReady()`. `additionalData` carries our argv to
// the primary instance which dispatches it via `second-instance`.
const gotLock = app.requestSingleInstanceLock({ argv: process.argv });
if (!gotLock) {
  app.quit();
  // Exit synchronously to avoid running any of the code below in the loser
  // instance — `app.quit()` only schedules a quit, it doesn't halt the script.
  process.exit(0);
}

app.on('second-instance', (_event, _argv, _wd, additionalData) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // additionalData is untrusted IPC payload from another local process —
  // validate shape before passing to the CLI parser.
  const data = additionalData as { argv?: unknown } | undefined;
  if (
    data &&
    Array.isArray(data.argv) &&
    data.argv.every((a): a is string => typeof a === 'string')
  ) {
    const cmd = parseCliArgs(data.argv);
    void executeCliCommand(cmd);
  }
});

/** Current-instance argv — may carry a CLI command to run at boot. */
const initialCliCommand: CliCommand = parseCliArgs(process.argv);
if (initialCliCommand.kind === 'help') {
  process.stdout.write(CLI_HELP);
  app.quit();
  process.exit(0);
}

/** Run a CLI command once the app is ready and the renderer has wired up. */
async function executeCliCommand(cmd: CliCommand): Promise<void> {
  if (cmd.kind === 'none' || cmd.kind === 'help' || cmd.kind === 'hidden') return;
  const w = mainWindow;
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  if (cmd.kind === 'focus') return;

  const path = await import('node:path');
  const cwd = cmd.cwd ?? process.cwd();
  const name = cmd.name ?? (path.basename(cwd) || 'session');
  log.info(`[cli] new session: agent=${cmd.agentId} cwd=${cwd} name=${name}`);
  try {
    const ptySession = await ptyManager.createSession({
      name,
      agentId: cmd.agentId,
      cwd,
      initialInput: cmd.prompt
    });
    const win = mainWindow;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.sessionUpdate, ptySession);
    }
  } catch (err) {
    log.error('[cli] failed to create session', err);
  }
}

/**
 * Install hardened CSP + permission handlers + web-contents hardening on the
 * default session. Called once after `whenReady`. CSP is enforced in prod only
 * — dev needs `unsafe-inline` for Vite HMR. Permission handlers run in both
 * modes so behavior matches production at dev time.
 */
function installSessionHardening(): void {
  const ses = session.defaultSession;

  if (!is.dev) {
    ses.webRequest.onHeadersReceived((details, callback) => {
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
              "child-src 'self' http://localhost:* http://127.0.0.1:*; " +
              "worker-src 'self' blob:; " +
              "object-src 'none'; " +
              "base-uri 'none'; " +
              "form-action 'none'"
          ],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer']
        }
      });
    });
  }

  // Deny every permission request unless we explicitly allow it. The renderer
  // is local trusted code; <webview>s in PreviewPane load user-controlled URLs
  // (localhost dev servers) and should NOT get mic/camera/geolocation/etc.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    // `clipboard-sanitized-write` is needed by the renderer for copy-button UX.
    // Everything else is denied by default.
    if (permission === 'clipboard-sanitized-write') return callback(true);
    log.info(`[security] denied permission request: ${permission}`);
    callback(false);
  });

  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'clipboard-sanitized-write') return true;
    return false;
  });
}

/**
 * Hardens every `webContents` created in the app — main window, detached
 * windows, and embedded <webview>s. Blocks navigation away from the app
 * origin, denies window.open, locks down webview attach options.
 */
function installWebContentsHardening(): void {
  app.on('web-contents-created', (_event, contents) => {
    // 1) Block top-frame navigation away from the renderer origin. A
    //    compromised renderer trying to navigate the main BrowserWindow to a
    //    foreign origin would otherwise inherit the preload script.
    contents.on('will-navigate', (event, url) => {
      const ok =
        url.startsWith('file://') ||
        url.startsWith('http://localhost') ||
        url.startsWith('http://127.0.0.1') ||
        (process.env.ELECTRON_RENDERER_URL !== undefined &&
          url.startsWith(process.env.ELECTRON_RENDERER_URL));
      if (!ok) {
        log.warn(`[security] blocked will-navigate to ${url}`);
        event.preventDefault();
      }
    });

    // 2) `window.open` from the main renderer or any webview → open in the
    //    user's default browser (only for safe http(s) URLs) and deny the
    //    in-app window. Centralized here so per-window setWindowOpenHandler
    //    becomes a defense-in-depth.
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          setImmediate(() => {
            void shell.openExternal(url);
          });
        } else {
          log.warn(`[security] refused to open external URL with protocol ${u.protocol}`);
        }
      } catch {
        log.warn(`[security] refused to open malformed URL: ${url}`);
      }
      return { action: 'deny' };
    });

    // 3) When a <webview> is about to attach, strip dangerous webPreferences
    //    and force-disable nodeIntegration. The webview tag is enabled for
    //    PreviewPane only and must never inherit Node integration.
    contents.on('will-attach-webview', (_e, webPreferences, params) => {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      // Only allow http/https/file URLs in <webview src>.
      const src = typeof params.src === 'string' ? params.src : '';
      if (
        src &&
        !/^https?:\/\//i.test(src) &&
        !src.startsWith('about:blank') &&
        !src.startsWith('data:')
      ) {
        log.warn(`[security] blocked <webview> attach with unsafe src: ${src}`);
        // Setting src to about:blank neutralizes the attach without throwing.
        params.src = 'about:blank';
      }
    });
  });
}

app.whenReady().then(async () => {
  // 1) Identity — must run before any window is created so Windows toasts +
  //    taskbar grouping pick up the AUMID.
  electronApp.setAppUserModelId(APP_USER_MODEL_ID);

  // 2) Security hardening (synchronous, cheap) before the first window.
  installSessionHardening();
  installWebContentsHardening();

  // 3) Dev-only browser-window keybind helper (F12 toggles DevTools, etc.).
  app.on('browser-window-created', (_e, w) => {
    optimizer.watchWindowShortcuts(w);
  });

  // 3b) Boot the PTY Host utilityProcess and AWAIT its ready handshake BEFORE
  //     registerIpc. registerIpc attaches `ptyManager.on('paneData', ...)` etc.
  //     synchronously, and the `ptyManager` Proxy throws if the client instance
  //     is not yet created — so this must complete first.
  const { initPtyHost } = await import('./pty-host-client-singleton');
  await initPtyHost();

  // 4) Register IPC before the window loads — the renderer wires up listeners
  //    in its bootstrap script and may call invoke() during the first tick.
  registerIpc(() => mainWindow);

  // 5) Create the window NOW. Everything else is deferred so first-paint isn't
  //    blocked by I/O.
  mainWindow = createWindow({ startHidden: initialCliCommand.kind === 'hidden' });

  // 6) Fire-and-forget initialization — fully parallel, each item logs its
  //    own failures. None of these should block window creation or each other.
  void ensureDevShortcutForNotifications(APP_USER_MODEL_ID);

  try {
    syncAutoLaunch(getSettings().autoLaunch);
  } catch (err) {
    log.warn('[autolaunch] initial sync failed', err);
  }

  // Paste temp cleanup (background, > 24h old files).
  void cleanupPasteTempFiles();

  // Install /vmux:orchestrate slash-command for Claude Code (idempotent).
  if (getSettings().claudeCommandsEnabled) {
    void installClaudeOrchestrateCommand();
  }

  // Crash detection — if the graceful-shutdown flag is still false at boot,
  // the previous run died without setting it cleanly.
  if (!getGracefulShutdown()) {
    log.warn('[main] crash detected — previous shutdown was not graceful');
  }
  setGracefulShutdown(false);

  // Auto-update — async but never awaited; the IPC handlers register
  // synchronously so the UI never stalls on "Checking…".
  void setupAutoUpdater(() => mainWindow);

  // 7) Defer work that depends on the renderer being attached to the
  //    `sessionUpdate` / `paneStatus` IPC channels. We hook `did-finish-load`
  //    instead of using a magic setTimeout — deterministic regardless of
  //    cold-start variance, dev/prod, or disk speed.
  const wc = mainWindow.webContents;
  const onRendererReady = (): void => {
    if (getSettings().autoRestoreOnBoot) {
      void ptyManager.autoRestoreSessions().then((n) => {
        if (n > 0) log.info(`[main] auto-restored ${n} pane(s)`);
      });
    }
    if (initialCliCommand.kind === 'new' || initialCliCommand.kind === 'focus') {
      void executeCliCommand(initialCliCommand);
    }
  };
  // `did-finish-load` may have already fired by the time we attach (Vite HMR
  // is fast). Use `once` + a fallback `webContents.isLoading()` check.
  if (wc.isLoading()) {
    wc.once('did-finish-load', onRendererReady);
  } else {
    onRendererReady();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
}).catch((err) => {
  log.error('[main] whenReady init failed', err);
  app.exit(1);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
// `before-quit` is the single source of truth for cleanup. It fires for:
//   - app.quit() (from menu, Cmd+Q, last window closed on win/linux)
//   - OS-initiated logoff/shutdown
//   - the auto-updater's "quit and install" flow
// We always run ptyManager.shutdown() so panes get a clean SIGTERM regardless
// of whether sessions were active.
let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  log.info('[main] before-quit — running graceful shutdown');
  stopAutoUpdater();
  void ptyManager
    .shutdown()
    .catch((err) => log.error('[main] ptyManager.shutdown failed', err))
    .finally(async () => {
      setGracefulShutdown(true);
      // After panes have been SIGTERM'd, tear down the PTY Host
      // utilityProcess itself. Best-effort: never block the exit tail on it.
      try {
        const { stopPtyHost } = await import('./pty-host-client-singleton');
        await stopPtyHost();
      } catch (err) {
        log.error('[main] stopPtyHost failed', err);
      }
      // 250ms tail: ConPTY/node-pty on Windows takes ~200-400ms to terminate
      // child processes cleanly. exit(0) skips before-quit re-entry.
      setTimeout(() => app.exit(0), 250);
    });
});

// On non-darwin, closing the last window triggers a quit. macOS keeps the
// app alive in the dock — we do nothing there.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
