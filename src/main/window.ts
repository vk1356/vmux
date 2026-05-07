import { app, BrowserWindow, screen, shell } from 'electron';
import { is } from '@electron-toolkit/utils';
import path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import log from 'electron-log/main';
import { IPC, type WindowState } from '@shared/types';
import { getWindowState, saveWindowState } from './settings-store';

/** Vérifie que les bounds sauvegardés sont toujours sur un écran connecté. */
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
  /** Si true, on ne montre pas la fenêtre au ready-to-show (mode --hidden). */
  startHidden?: boolean;
}

export function createWindow(opts: CreateWindowOptions = {}): BrowserWindow {
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
    if (!opts.startHidden) win.show();
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
 * seule fois via PowerShell. Idempotent.
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
    const exists = await fs.promises.access(shortcutPath).then(() => true).catch(() => false);
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
export function syncAutoLaunch(enabled: boolean): void {
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
