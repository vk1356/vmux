import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';
import log from 'electron-log/main';
import { DEFAULT_AGENTS } from '@shared/agents';
import { checkAgents } from './agent-check';
import { ptyManager } from './pty-manager';
import { getSettings } from './settings-store';

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
  agents: Array<{ id: string; label: string; found: boolean; resolvedPath?: string }>;
  sessions: Array<{ id: string; name: string; cwd: string; branch?: string; paneCount: number }>;
  settings: ReturnType<typeof getSettings>;
  recentLogs: string;
}

/** Génère un rapport de diagnostic anonymisé en JSON. */
export async function generateDiagnostic(): Promise<DiagnosticReport> {
  const sessions = ptyManager.list();
  const agents = await checkAgents(DEFAULT_AGENTS);
  const settings = getSettings();

  // Lit les 200 dernières lignes du log si possible.
  let recentLogs = '';
  try {
    const logPath = log.transports.file.getFile().path;
    const content = await fsp.readFile(logPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    recentLogs = lines.slice(-200).join('\n');
  } catch {
    recentLogs = '(log file not available)';
  }

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
      found: a.found,
      resolvedPath: a.resolvedPath
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      branch: s.branch,
      paneCount: Object.keys(s.panes).length
    })),
    settings: { ...settings, agentOverrides: {} }, // anonymisé : pas de secrets
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
