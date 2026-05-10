import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentPreset } from '@shared/types';
import { quotePsLiteral, quoteShLiteral } from '@shared/utils';

export interface ShellSpawnSpec {
  exe: string;
  args: string[];
}

/**
 * Détecte le meilleur shell disponible selon la plateforme.
 * - Windows : préfère pwsh 7+, sinon Windows PowerShell.
 * - macOS : `$SHELL` (typiquement zsh sur macOS Catalina+), fallback zsh puis bash.
 * - Linux : `$SHELL`, fallback bash.
 * Retourne le chemin absolu pour éviter toute ambiguïté avec PATH/PATHEXT.
 */
export function detectDefaultShell(): ShellSpawnSpec {
  if (process.platform === 'win32') {
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

  // POSIX : préfère $SHELL, fallback ordonné. -l pour login shell (charge .zshrc/.bashrc).
  const fromEnv = process.env.SHELL;
  if (fromEnv && existsSync(fromEnv)) return { exe: fromEnv, args: ['-l'] };

  const macFallbacks = ['/bin/zsh', '/bin/bash'];
  const linuxFallbacks = ['/bin/bash', '/bin/sh'];
  const fallbacks = process.platform === 'darwin' ? macFallbacks : linuxFallbacks;
  for (const c of fallbacks) {
    if (existsSync(c)) return { exe: c, args: ['-l'] };
  }
  return { exe: '/bin/sh', args: [] };
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

/** Construit la ligne à écrire dans le shell pour démarrer l'agent.
 *  Sur Windows on utilise le quoting PowerShell ; sur macOS/Linux le quoting POSIX. */
export function buildAgentBootLine(agent: AgentPreset): string {
  if (agent.id === 'shell' || !agent.command) return '';
  if (agent.command === 'pwsh' || agent.command === 'powershell') return '';
  if (agent.command === 'bash' || agent.command === 'zsh' || agent.command === 'sh') return '';
  const quote = process.platform === 'win32' ? quotePsLiteral : quoteShLiteral;
  const cmd = quote(agent.command);
  const args = agent.args.map(quote).join(' ');
  return args ? `${cmd} ${args}` : cmd;
}
