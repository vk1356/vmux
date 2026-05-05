import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentPreset } from '@shared/types';
import { quotePsLiteral } from '@shared/utils';

export interface ShellSpawnSpec {
  exe: string;
  args: string[];
}

/**
 * Détecte le meilleur shell disponible sur Windows.
 * Préfère pwsh (PowerShell 7+) si installé, sinon Windows PowerShell.
 * Retourne le chemin absolu pour éviter toute ambiguïté avec PATHEXT.
 */
export function detectDefaultShell(): ShellSpawnSpec {
  if (process.platform !== 'win32') {
    return { exe: process.env.SHELL || '/bin/bash', args: [] };
  }

  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const candidates = [
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
  ];

  for (const c of candidates) {
    if (existsSync(c)) return { exe: c, args: ['-NoLogo'] };
  }

  return { exe: 'powershell.exe', args: ['-NoLogo'] };
}

/**
 * Tous les agents tournent dans pwsh interactif. La commande de boot
 * (claude / codex / aider / etc.) est écrite après réception du premier output
 * (signal "shell prêt à recevoir") — voir pty-manager.ts.
 *
 * Ce design garantit que :
 * - le user reste dans pwsh même si l'agent quitte (Ctrl+C),
 * - la résolution PATHEXT (.cmd / .exe / .ps1) est gérée par pwsh nativement,
 * - les agents qui détectent une tty fonctionnent (ConPTY est attaché à pwsh).
 */
export function getInteractiveShell(): ShellSpawnSpec {
  return detectDefaultShell();
}

/** Construit la ligne à écrire dans le shell pour démarrer l'agent. */
export function buildAgentBootLine(agent: AgentPreset): string {
  if (agent.id === 'shell' || !agent.command) return '';
  if (agent.command === 'pwsh' || agent.command === 'powershell') return '';
  const cmd = quotePsLiteral(agent.command);
  const args = agent.args.map(quotePsLiteral).join(' ');
  return args ? `${cmd} ${args}` : cmd;
}
