import { app, BrowserWindow, ipcMain } from 'electron';
import { is } from '@electron-toolkit/utils';
import path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import log from 'electron-log/main';
import { IPC, type UpdateStatus } from '@shared/types';
import { isNewer } from './version-compare';

// Re-export pour compat ascendante (l'API publique du module reste identique).
export { isNewer };

/**
 * Auto-update extrait de main/index.ts pour cloisonner ~350 lignes de logique
 * réseau / installer.
 *
 * Stratégie :
 * - Check primaire = API GitHub direct (rapide, fiable, fonctionne en dev).
 *   Timeout dur 8s via AbortController. Compare app.getVersion() vs tag_name.
 * - electron-updater est utilisé pour le download différentiel via blockmap.
 *   `autoDownload=true` → quand le check primaire détecte une version, on
 *   trigger automatiquement le download en background.
 *   `autoInstallOnAppQuit=true` → à la fermeture de l'app, l'installer NSIS
 *   tourne en silent mode (`/S`) et remplace le binaire. Au prochain launch,
 *   l'user a la nouvelle version sans aucun click.
 * - L'IPC `updateInstall` reste exposé pour le bouton "Install now" (force
 *   l'install immédiat au lieu d'attendre le quit).
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

type GhRelease = {
  tag_name: string;
  name?: string;
  body?: string;
  assets?: { name: string; browser_download_url: string }[];
};

interface LatestInfo {
  version: string;
  notes?: string;
  installerUrl?: string;
}

type SendStatus = (s: UpdateStatus) => void;

/** Asset matching par plateforme : NSIS (Windows), DMG (macOS), AppImage (Linux). */
function matchInstallerAsset(name: string): boolean {
  if (name.endsWith('.blockmap')) return false;
  if (process.platform === 'win32') return /Setup.*\.exe$/i.test(name);
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return new RegExp(`-${arch}\\.dmg$`, 'i').test(name) || /\.dmg$/i.test(name);
  }
  return /\.AppImage$/i.test(name);
}

/** Fetch JSON avec timeout dur via AbortController. Throw en cas d'erreur. */
async function ghFetchLatest(repo: string, timeoutMs = 8000): Promise<LatestInfo> {
  log.info(
    `[updater] fetch https://api.github.com/repos/${repo}/releases/latest (timeout=${timeoutMs}ms)`
  );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
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
    const installer = data.assets?.find((a) => matchInstallerAsset(a.name));
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

/** Télécharge l'installer dans le dossier temp avec progress.
 *  Extension dérivée de la plateforme pour rester correcte sur win/mac/linux. */
async function manualDownloadAndPrepare(
  installerUrl: string,
  version: string,
  sendStatus: SendStatus
): Promise<string> {
  const tmpDir = path.join(app.getPath('temp'), 'vmux-updater');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const ext =
    process.platform === 'win32' ? 'exe' : process.platform === 'darwin' ? 'dmg' : 'AppImage';
  const tmpPath = path.join(tmpDir, `vMux-Setup-${version}.${ext}`);

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

/** Lance l'installer (NSIS sur Win, DMG mounté sur macOS, AppImage sur Linux)
 *  et quitte l'app. Sur macOS/Linux la procédure se limite à ouvrir le fichier
 *  dans le Finder/Files — l'user installe à la main. */
function runInstallerAndQuit(installerPath: string, sendStatus: SendStatus): void {
  log.info(`[updater] launching ${installerPath}`);
  try {
    if (process.platform === 'win32') {
      const child = spawn(installerPath, ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } else {
      // Ouvre le DMG/AppImage dans le file manager — pas d'install silencieuse
      // possible sans privilèges sur macOS/Linux pour des apps non-MAS.
      void import('electron').then(({ shell }) => shell.showItemInFolder(installerPath));
    }
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

/**
 * Le flow "manual download" complet : fetch latest → download → status downloaded.
 * Retourne le path de l'installer si succès, null sinon (en plus de cleanly
 * sendStatus(error)). Factorise un pattern qui apparaissait à 3 endroits.
 */
async function runManualUpdateFlow(
  repo: string,
  sendStatus: SendStatus
): Promise<string | null> {
  try {
    const latest = await ghFetchLatest(repo);
    if (!latest.installerUrl) {
      sendStatus({
        kind: 'error',
        code: 'no-installer-url',
        message: 'Installer URL not found in latest release.'
      });
      return null;
    }
    sendStatus({
      kind: 'downloading',
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0
    });
    const tmpPath = await manualDownloadAndPrepare(
      latest.installerUrl,
      latest.version,
      sendStatus
    );
    sendStatus({
      kind: 'downloaded',
      version: latest.version,
      releaseNotes: latest.notes
    });
    return tmpPath;
  } catch (err) {
    sendStatus({
      kind: 'error',
      code: 'github-api-failed',
      message: (err as Error).message
    });
    return null;
  }
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
  const sendStatus: SendStatus = (s) => {
    lastSentStatus = s.kind;
    send(s);
  };

  // Source de vérité unique : la conf publish dans package.json. Évite la
  // désynchronisation si on transfère le repo. Fallback hardcodé en dev.
  const REPO = await readRepoFromUpdateConfig().catch(() => 'vk1356/vmux');

  /** Path du dernier installer téléchargé manuellement, prêt à être lancé. */
  let pendingManualInstaller: string | null = null;
  /** Référence vers le module electron-updater (lazy-imported plus bas).
   *  Quand non-null, le check primaire trigger un auto-download en background. */
  let autoUpdaterRef: typeof import('electron-updater').autoUpdater | null = null;
  /** Anti-spam : évite de re-trigger un download si le précédent tourne déjà
   *  ou si on est passé à 'downloading' / 'downloaded'. */
  let autoDownloadTriggered = false;

  /** Check primaire : API GitHub. Aucun hang possible (timeout 8s strict).
   *  Si une version plus récente est détectée ET que electron-updater est dispo,
   *  on trigger un auto-download silencieux (autoDownload=true). */
  async function checkUpdates(): Promise<void> {
    log.info('[updater] checkUpdates() called');
    sendStatus({ kind: 'checking' });
    const local = app.getVersion();
    try {
      const latest = await ghFetchLatest(REPO);
      log.info(`[updater] local=${local} remote=${latest.version}`);
      if (isNewer(latest.version, local)) {
        sendStatus({
          kind: 'available',
          version: latest.version,
          releaseNotes: latest.notes
        });
        // Auto-download en background via electron-updater (blockmap diff).
        // À la fermeture de l'app → install silencieux via autoInstallOnAppQuit.
        if (autoUpdaterRef && !autoDownloadTriggered) {
          autoDownloadTriggered = true;
          try {
            log.info('[updater] auto-download triggered (silent install on quit)');
            await autoUpdaterRef.checkForUpdates();
          } catch (e) {
            log.warn('[updater] auto checkForUpdates failed', e);
            // Reset le flag : si l'user clique Download manuellement plus tard,
            // on veut bien que le flow re-tente.
            autoDownloadTriggered = false;
          }
        }
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
      pendingManualInstaller = await runManualUpdateFlow(REPO, sendStatus);
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

  // Mode prod : tente electron-updater pour le download différentiel via blockmap,
  // fallback sur le manual flow si indisponible (CI build sans deps, etc.).
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.logger = log;
    // Mode silencieux à la cmd Claude Code : background download + install au quit.
    // L'user ne voit jamais de prompt sauf s'il choisit "Install now" via le banner.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdaterRef = autoUpdater;

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
        log.info('[updater] manual download requested');
        // autoDownload=true → checkForUpdates() trigger lui-même le download.
        // Pas besoin d'un downloadUpdate() supplémentaire (il duplique le travail
        // si l'auto-download a déjà démarré via le check au boot).
        autoDownloadTriggered = true;
        await autoUpdater.checkForUpdates();
      } catch (err) {
        log.warn('[updater] electron-updater download failed, manual fallback', err);
        pendingManualInstaller = await runManualUpdateFlow(REPO, sendStatus);
      }
    });

    ipcMain.handle(IPC.updateInstall, () => {
      if (pendingManualInstaller) {
        runInstallerAndQuit(pendingManualInstaller, sendStatus);
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
      pendingManualInstaller = await runManualUpdateFlow(REPO, sendStatus);
    });
    ipcMain.handle(IPC.updateInstall, () => {
      if (pendingManualInstaller) {
        runInstallerAndQuit(pendingManualInstaller, sendStatus);
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
