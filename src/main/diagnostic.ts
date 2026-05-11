import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import log from 'electron-log/main';
import { DEFAULT_AGENTS } from '@shared/agents';
import { checkAgents } from './agent-check';
import { ptyManager } from './pty-manager';
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

/** Pour un chemin Windows/POSIX, remplace le préfixe homedir par `~` pour ne
 *  pas leak le username dans un fichier partageable. */
function redactHome(p: string | undefined): string | undefined {
  if (!p) return p;
  const home = os.homedir();
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

/** Scrub une ligne de log de tout ce qui ressemble à un secret. */
function scrubLogLine(line: string): string {
  return (
    line
      // Remplace les chemins absolus contenant le homedir.
      .replace(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~')
      // API keys / tokens (Bearer, x-api-key, sk-/pk-/ghp-/ghs-, etc.).
      .replace(/(?:bearer|api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$&'.split(/[:=]/)[0] + '=<redacted>')
      .replace(/\b(?:sk|pk|ghp|ghs|gho|github_pat)[_-][A-Za-z0-9]{20,}/g, '<redacted-token>')
  );
}

/** Génère un rapport de diagnostic anonymisé en JSON. */
export async function generateDiagnostic(): Promise<DiagnosticReport> {
  const sessions = ptyManager.list();
  const agents = await checkAgents(DEFAULT_AGENTS);
  const settings = getSettings();

  // Lit les 200 dernières lignes du log si possible, en scrubbant les patterns
  // de secrets (tokens API, paths absolus, etc.).
  let recentLogs = '';
  try {
    const logPath = log.transports.file.getFile().path;
    const content = await fsp.readFile(logPath, 'utf-8');
    const lines = content.split(/\r?\n/).slice(-200).map(scrubLogLine);
    recentLogs = lines.join('\n');
  } catch {
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
}

/** Suggestion de chemin par défaut. */
export function defaultDiagnosticFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(os.homedir(), 'Desktop', `vmux-diagnostic-${ts}.json`);
}
