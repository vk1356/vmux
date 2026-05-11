import { app, BrowserWindow, screen, shell } from 'electron';
import { is } from '@electron-toolkit/utils';
import path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import log from 'electron-log/main';
import { IPC, type WindowState } from '@shared/types';
import { getWindowState, saveWindowState } from './settings-store';

/** Verify saved bounds still intersect a connected display (laptop unplugged
 *  from external monitor, display moved, etc.). Falls back to centered defaults. */
export function clampToScreens(state: WindowState): WindowState {
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

interface CreateWindowOptions {
  /** If true, don't show the window on `ready-to-show` (--hidden CLI flag). */
  startHidden?: boolean;
}

/** webPreferences shared between the main window and detached windows —
 *  single source of truth. `sandbox: false` is required because the preload
 *  uses `webUtils` (drag-drop file paths) and electron-toolkit helpers that
 *  need a non-sandboxed preload. `webviewTag: true` is required for the
 *  PreviewPane (`<webview>` isolated). `will-attach-webview` in
 *  `src/main/index.ts` enforces a sandboxed, nodeIntegration-free webview at
 *  attach time so the relaxed preload sandbox does not bleed into webviews. */
function sharedWebPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false
  };
}

/** Open a URL in the user's default browser if and only if it is http(s).
 *  Centralized so every window's `setWindowOpenHandler` uses the same policy
 *  even though `web-contents-created` in index.ts is already defense-in-depth. */
function openSafeExternal(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      void shell.openExternal(url);
    } else {
      log.warn(`[security] refused external open with protocol ${u.protocol}`);
    }
  } catch {
    log.warn(`[security] refused malformed external URL: ${url}`);
  }
}

/** Wire up the debounced window-state persistence and return a `dispose` that
 *  cancels the trailing timer when the window is closed mid-debounce. */
function attachWindowStatePersistence(win: BrowserWindow): () => void {
  let saveTimer: NodeJS.Timeout | null = null;
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (win.isDestroyed()) return;
      const isMax = win.isMaximized();
      const bounds = isMax ? win.getNormalBounds() : win.getBounds();
      saveWindowState({ ...bounds, isMaximized: isMax });
    }, 200);
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);
  return () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
}

export function createWindow(opts: CreateWindowOptions = {}): BrowserWindow {
  const saved = clampToScreens(getWindowState());

  // Platform conventions:
  //   - Windows / Linux: fully frameless, we draw our own TitleBar.
  //   - macOS: keep native traffic lights (`hiddenInset`) so users don't lose
  //     close/minimize/zoom — bad form to remove them on darwin.
  const isDarwin = process.platform === 'darwin';
  const titleBarOpts: Electron.BrowserWindowConstructorOptions = isDarwin
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } }
    : { frame: false, titleBarStyle: 'hidden' };

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
    autoHideMenuBar: true,
    ...titleBarOpts,
    webPreferences: sharedWebPreferences()
  });

  win.on('ready-to-show', () => {
    if (saved.isMaximized) win.maximize();
    if (!opts.startHidden) win.show();
  });

  // Notify renderer of maximize state changes — guard against post-close sends.
  const sendMaximized = (v: boolean) => (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.windowMaximizedChanged, v);
    }
  };
  win.on('maximize', sendMaximized(true));
  win.on('unmaximize', sendMaximized(false));

  const disposePersist = attachWindowStatePersistence(win);
  win.on('closed', disposePersist);

  // Defense-in-depth: even though `app.on('web-contents-created')` (index.ts)
  // registers a global handler, the per-window handler ensures policy is in
  // place even if event ordering ever drifts.
  win.webContents.setWindowOpenHandler((details) => {
    openSafeExternal(details.url);
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
 * Create a detached window that renders a single session (no sidebar). The
 * renderer detects the mode via the URL hash (`#detached=<sessionId>`).
 * Detached windows do not persist their size (each open uses the defaults)
 * and have `autoHideMenuBar: true` to avoid interfering with the main
 * window. PTY events are broadcast to all BrowserWindows (see ipc.ts), so
 * both windows stay in sync.
 */
export function createDetachedWindow(sessionId: string): BrowserWindow {
  const isDarwin = process.platform === 'darwin';
  const titleBarOpts: Electron.BrowserWindowConstructorOptions = isDarwin
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } }
    : { frame: false, titleBarStyle: 'hidden' };

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 480,
    minHeight: 360,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'vMux — Session',
    autoHideMenuBar: true,
    ...titleBarOpts,
    webPreferences: sharedWebPreferences()
  });

  win.on('ready-to-show', () => win.show());

  const sendMaximized = (v: boolean) => (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.windowMaximizedChanged, v);
    }
  };
  win.on('maximize', sendMaximized(true));
  win.on('unmaximize', sendMaximized(false));

  win.webContents.setWindowOpenHandler((details) => {
    openSafeExternal(details.url);
    return { action: 'deny' };
  });

  // Hash-route the renderer to single-session mode.
  const hash = `detached=${encodeURIComponent(sessionId)}`;
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  }

  return win;
}

/**
 * In dev mode, Windows does not deliver native toast notifications unless the
 * AppUserModel.ID is associated with a Start Menu shortcut. In prod, NSIS
 * creates that shortcut with the correct AUMID — nothing to do. For dev, we
 * generate `vMux (Dev).lnk` once via PowerShell. Idempotent. Best-effort:
 * any failure only loses dev-time notifications, never blocks boot.
 */
export async function ensureDevShortcutForNotifications(aumid: string): Promise<void> {
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
    const exists = await fs.promises
      .access(shortcutPath)
      .then(() => true)
      .catch(() => false);
    if (exists) return;
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
      // Hard 10s timeout — on some configs (corrupt profile, AV scanning
      // PowerShell), powershell.exe can freeze at init. Better to lose dev
      // notifications than block main-process boot.
      const killer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 10_000);
      const cleanup = (): void => {
        clearTimeout(killer);
        resolve();
      };
      child.once('exit', cleanup);
      child.once('error', cleanup);
    });
    log.info(`[notif] dev shortcut prepared at ${shortcutPath} (aumid=${aumid})`);
  } catch (err) {
    log.warn('[notif] dev shortcut creation failed (notifs may not appear in dev)', err);
  }
}

/** Sync `app.setLoginItemSettings` with the `autoLaunch` setting. In dev we
 *  do nothing — the executable path is electron.exe, not vMux.exe, and we
 *  don't want to register the dev binary at login. Linux: Electron 41+
 *  supports setLoginItemSettings via `.desktop` files in `~/.config/autostart`. */
export function syncAutoLaunch(enabled: boolean): void {
  if (is.dev) return;
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: ['--hidden']
      });
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    } else if (process.platform === 'linux') {
      // No --hidden on linux: window managers don't honor it uniformly.
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
    log.info(`[autolaunch] openAtLogin=${enabled}`);
  } catch (err) {
    log.warn('[autolaunch] failed to set login item', err);
  }
}
