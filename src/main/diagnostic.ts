import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import log from 'electron-log/main';
import { DEFAULT_AGENTS } from '@shared/agents';
import { checkAgents } from './agent-check';
// Live host-client proxy — NOT './pty-manager' (that singleton runs in the main
// process and is always empty; real sessions live in the PTY-host utilityProcess).
import { ptyManager } from './pty-host-client-singleton';
import { getSettings } from './settings-store';

interface SafeDiagnosticSettings {
  theme: string;
  language: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  webglRenderer: boolean;
  notificationsEnabled: boolean;
  notificationSound: string;
  autoLaunch: boolean;
  autoRestoreOnBoot: boolean;
  cdpEnabled: boolean;
  cdpPort: number;
  claudeCommandsEnabled: boolean;
}

interface DiagnosticReport {
  generatedAt: string;
  version: {
    vmux: string;
    electron: string;
    chrome: string;
    node: string;
  };
  os: {
    platform: NodeJS.Platform;
    release: string;
    arch: string;
    cpus: number;
    totalMemMB: number;
    freeMemMB: number;
  };
  agents: Array<{ id: string; label: string; found: boolean }>;
  sessions: Array<{ id: string; name: string; cwd: string; branch?: string; paneCount: number }>;
  settings: SafeDiagnosticSettings;
  recentLogs: string;
}

// Pré-compile les regex de scrubbing — appelées 200x par diagnostic.
// La regex homedir est invalidée à la volée puisque os.homedir() peut changer
// rarement (impersonation Windows) mais en pratique c'est constant.
const HOME_DIR = os.homedir();
const HOME_DIR_RE = HOME_DIR
  ? new RegExp(HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  : null;
// Capture `key:value` ou `key=value` où key ∈ {bearer, api_key, token, password, secret}.
// On group la valeur séparément pour la remplacer sans toucher le label.
const SECRET_KV_RE = /\b(bearer|api[_-]?key|token|password|secret)\s*([:=])\s*\S+/gi;
const TOKEN_RE = /\b(?:sk|pk|ghp|ghs|gho|github_pat)[_-][A-Za-z0-9]{20,}/g;

// Limite hard sur la taille du log lu pour le diagnostic : ~512 KB max.
// Si le user a `maxSize=0` (rotation off) ou que le fichier a été restauré
// depuis un backup, on évite de tenter de charger 200 MB en RAM.
const MAX_LOG_READ_BYTES = 512 * 1024;
const RECENT_LOG_LINES = 200;

/** Pour un chemin Windows/POSIX, remplace le préfixe homedir par `~` pour ne
 *  pas leak le username dans un fichier partageable. */
function redactHome(p: string | undefined): string | undefined {
  if (!p) return p;
  if (HOME_DIR && p.startsWith(HOME_DIR)) return '~' + p.slice(HOME_DIR.length);
  return p;
}

/** Scrub une ligne de log de tout ce qui ressemble à un secret. */
function scrubLogLine(line: string): string {
  let out = line;
  if (HOME_DIR_RE) {
    // Reset car flag /g garde lastIndex entre appels.
    HOME_DIR_RE.lastIndex = 0;
    out = out.replace(HOME_DIR_RE, '~');
  }
  out = out.replace(SECRET_KV_RE, (_full, label: string, sep: string) => `${label}${sep}<redacted>`);
  out = out.replace(TOKEN_RE, '<redacted-token>');
  return out;
}

/** Lit les N derniers octets d'un fichier sans charger tout en RAM. */
async function tailFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString('utf-8');
  } finally {
    await handle.close();
  }
}

/** Génère un rapport de diagnostic anonymisé en JSON. */
export async function generateDiagnostic(): Promise<DiagnosticReport> {
  const sessions = ptyManager.list();
  const agents = await checkAgents(DEFAULT_AGENTS);
  const settings = getSettings();

  // Lit les dernières lignes du log (capées à 512 KB + 200 lignes) en scrubbant
  // les patterns de secrets (tokens API, paths absolus, etc.).
  // eslint-disable-next-line no-useless-assignment -- initializer makes TypeScript control-flow happy; both branches of try/catch overwrite it
  let recentLogs = '';
  try {
    const logPath = log.transports.file.getFile().path;
    const content = await tailFile(logPath, MAX_LOG_READ_BYTES);
    const lines = content.split(/\r?\n/).slice(-RECENT_LOG_LINES).map(scrubLogLine);
    recentLogs = lines.join('\n');
  } catch (err) {
    log.warn('[diagnostic] could not read log file', err);
    recentLogs = '(log file not available)';
  }

  // Whitelist : ne reporte que les settings non-sensibles. notificationSoundPath,
  // defaultShell, agentOverrides, lastActiveSessionId, sidebarWidth, etc. sont
  // exclus (chemins absolus, données privées, ou non-utiles pour debug).
  const safeSettings: SafeDiagnosticSettings = {
    theme: settings.theme,
    language: settings.language,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback,
    webglRenderer: settings.webglRenderer,
    notificationsEnabled: settings.notificationsEnabled,
    notificationSound: settings.notificationSound,
    autoLaunch: settings.autoLaunch,
    autoRestoreOnBoot: settings.autoRestoreOnBoot,
    cdpEnabled: settings.cdpEnabled,
    cdpPort: settings.cdpPort,
    claudeCommandsEnabled: settings.claudeCommandsEnabled
  };

  return {
    generatedAt: new Date().toISOString(),
    version: {
      vmux: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node
    },
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMB: Math.round(os.freemem() / 1024 / 1024)
    },
    agents: agents.map((a) => ({
      id: a.id,
      label: DEFAULT_AGENTS.find((x) => x.id === a.id)?.label ?? a.id,
      found: a.found
      // resolvedPath retiré : leak le username via C:\Users\<name>\...
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: redactHome(s.cwd) ?? s.cwd,
      branch: s.branch,
      paneCount: Object.keys(s.panes).length
    })),
    settings: safeSettings,
    recentLogs
  };
}

/** Sauve le rapport dans le fichier choisi par l'utilisateur. */
export async function saveDiagnosticTo(filePath: string): Promise<void> {
  const report = await generateDiagnostic();
  await fsp.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
  log.info(`[diagnostic] saved report to ${redactHome(filePath)}`);
}

/** Suggestion de chemin par défaut. */
export function defaultDiagnosticFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(os.homedir(), 'Desktop', `vmux-diagnostic-${ts}.json`);
}

// ============================================================
// Log rotation / configuration
// ============================================================
//
// electron-log file transport rotation : par défaut, maxSize = 1 MB → rotate
// vers `{filename}.old.log`. Donc historique = 2 MB max, déjà ok. On surcharge
// uniquement pour : (a) bumper la limite à 5 MB par fichier (= 10 MB total)
// pour avoir plus d'historique sur des bugs longs à reproduire, (b) appliquer
// un format daté lisible, (c) capper la profondeur d'introspection des objets
// loggés (évite des stack traces 10MB qui crash le log lui-même).
//
// IMPORTANT : `archiveLogFn` reste le défaut electron-log (rename `.old.log`).
// On ne le redéfinit pas en async/fs.rm parce que electron-log appelle
// archiveLogFn DANS l'event loop main + s'attend à du sync. Une fs.rm async
// laisserait le main rotation-broken pendant le flush.

// Auto-configured on module import — diagnostic.ts est importé via ipc.ts au
// boot, donc avant tout log significatif. Idempotent : si l'utilisateur a déjà
// re-tuné `log.transports.file.maxSize` ailleurs, on respecte sa valeur tant
// qu'elle est > 0.
(function configureLogging(): void {
  try {
    if (!log.transports.file.maxSize || log.transports.file.maxSize <= 1024 * 1024) {
      log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB par fichier, ~10 MB total
    }
    log.transports.file.format =
      '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{processType}] {text}';
    log.transports.file.inspectOptions = { depth: 4, maxArrayLength: 50 };

    // Scrubbing global : tout ce qui part vers le fichier passe par scrubLogLine.
    // Évite les fuites accidentelles (log.error(err) où err.config.headers.authorization).
    log.hooks.push((message, _transport, transportName) => {
      if (transportName !== 'file') return message;
      const scrubbed = message.data.map((d) => (typeof d === 'string' ? scrubLogLine(d) : d));
      return { ...message, data: scrubbed };
    });
  } catch {
    // electron-log non encore initialisé ou config readonly — on ignore plutôt
    // que de bloquer le boot.
  }
})();
