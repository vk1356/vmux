import { app, BrowserWindow, ipcMain } from 'electron';
import { is } from '@electron-toolkit/utils';
import path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import log from 'electron-log/main';
import { IPC, type UpdateStatus } from '@shared/types';

/**
 * Auto-update extrait de main/index.ts pour cloisonner ~350 lignes de logique
 * réseau / installer. L'orchestrateur principal n'a plus qu'à appeler
 * `setupAutoUpdater(getMainWindow)` au boot et `stopAutoUpdater()` au shutdown.
 *
 * Stratégie :
 * - Check primaire = API GitHub direct (rapide, fiable, fonctionne en dev).
 *   Timeout dur 8s via AbortController. Compare app.getVersion() vs tag_name.
 * - electron-updater n'est utilisé QUE pour le download différentiel via
 *   blockmap quand l'user clique "Download".
 * - Tous les paths d'erreur envoient un statut UpdateStatus avec un `code`
 *   traduisible côté renderer.
 */

let updateRecheckInterval: NodeJS.Timeout | null = null;

export function stopAutoUpdater(): void {
  if (updateRecheckInterval) {
    clearInterval(updateRecheckInterval);
    updateRecheckInterval = null;
  }
}

/** Lit owner/repo depuis app-update.yml (prod) ou retombe sur les valeurs du
 *  build config bundlé. Renvoie sous forme `owner/repo` pour l'API GitHub. */
async function readRepoFromUpdateConfig(): Promise<string> {
  const candidates = [
    path.join(process.resourcesPath, 'app-update.yml'),
    path.join(process.resourcesPath, 'app', 'app-update.yml')
  ];
  for (const p of candidates) {
    try {
      const yml = await fs.promises.readFile(p, 'utf-8');
      const owner = yml.match(/^owner:\s*(\S+)/m)?.[1];
      const repo = yml.match(/^repo:\s*(\S+)/m)?.[1];
      if (owner && repo) return `${owner}/${repo}`;
    } catch {
      /* try next */
    }
  }
  throw new Error('app-update.yml not found');
}

export async function setupAutoUpdater(
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const send = (status: UpdateStatus): void => {
    const w = getMainWindow();
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(IPC.updateStatus, status);
  };

  let lastSentStatus: UpdateStatus['kind'] = 'idle';
  const sendStatus = (s: UpdateStatus): void => {
    lastSentStatus = s.kind;
    send(s);
  };

  // Source de vérité unique : la conf publish dans package.json. Évite la
  // désynchronisation si on transfère le repo. Fallback hardcodé en dev.
  const REPO = await readRepoFromUpdateConfig().catch(() => 'vk1356/vmux');
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
    log.info(
      `[updater] fetch https://api.github.com/repos/${REPO}/releases/latest (timeout=${timeoutMs}ms)`
    );
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

  /** Télécharge l'installer NSIS dans le dossier temp avec progress. */
  async function manualDownloadAndPrepare(
    installerUrl: string,
    version: string
  ): Promise<string> {
    const tmpDir = path.join(app.getPath('temp'), 'vmux-updater');
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `vMux-Setup-${version}.exe`);

    log.info(`[updater] manual download from ${installerUrl} → ${tmpPath}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
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

  /** Lance l'installer NSIS en silencieux et quitte l'app. */
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
    setTimeout(() => app.exit(0), 800);
  }

  /** Check primaire : API GitHub. Aucun hang possible (timeout 8s strict). */
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

  ipcMain.handle(IPC.updateCheck, () => checkUpdates());

  // Mode dev : pas d'electron-updater (pas d'app-update.yml). Install = no-op.
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
        await autoUpdater.checkForUpdates();
        await autoUpdater.downloadUpdate();
      } catch (err) {
        log.warn('[updater] electron-updater download failed, manual fallback', err);
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
      if (pendingManualInstaller) {
        runInstallerAndQuit(pendingManualInstaller);
        return;
      }
      if (lastSentStatus === 'downloaded') {
        log.info('[updater] electron-updater quitAndInstall');
        autoUpdater.quitAndInstall(true, true);
        return;
      }
      sendStatus({
        kind: 'error',
        code: 'install-no-download',
        message: 'Download not completed — re-run download first.'
      });
    });

    setTimeout(() => void checkUpdates(), 3000);
    updateRecheckInterval = setInterval(() => void checkUpdates(), 4 * 60 * 60 * 1000);
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
