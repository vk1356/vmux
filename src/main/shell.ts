import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentPreset } from '@shared/types';
import { quotePsLiteral, quoteShLiteral } from '@shared/utils';

export interface ShellSpawnSpec {
  exe: string;
  args: string[];
}

/** Memo du shell détecté — la détection scanne le FS (existsSync) ce qui n'a
 *  pas besoin de tourner à chaque spawn de pane. L'utilisateur ne déplace pas
 *  pwsh.exe pendant qu'il utilise vMux. Invalidé jamais pendant la vie du
 *  process — Electron a un cycle de vie court de toute façon.
 *
 *  NB: garder l'API synchrone car appelée depuis pty-manager.spawnPane qui est
 *  un chemin synchrone (le coût FS n'est payé qu'une fois grâce au cache). */
let cachedShell: ShellSpawnSpec | null = null;

/**
 * Valide un chemin de shell utilisateur (typiquement `process.env.SHELL`).
 * Refuse les NUL bytes, les paths relatifs, et tout caractère de contrôle qui
 * pourrait smuggler des arguments si un futur appelant l'utilisait sans
 * précaution. node-pty appelle `CreateProcess` / `execvp` directement sans
 * shell, donc la surface d'attaque est limitée, mais on durcit en defense en
 * profondeur — un `$SHELL=/usr/bin/env\0--malicious` est rejeté.
 */
function isSafeShellPath(p: string | undefined | null): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  return path.isAbsolute(p);
}

/**
 * Détecte le meilleur shell disponible selon la plateforme.
 * - Windows : préfère pwsh 7+, sinon Windows PowerShell.
 * - macOS : `$SHELL` (typiquement zsh sur macOS Catalina+), fallback zsh puis bash.
 * - Linux : `$SHELL`, fallback bash.
 * Retourne le chemin absolu pour éviter toute ambiguïté avec PATH/PATHEXT
 * (sécurité Windows : éviter le bug de lookup .cmd/.bat corrigé en Node 20+).
 */
export function detectDefaultShell(): ShellSpawnSpec {
  if (cachedShell) return cachedShell;

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const candidates = [
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        cachedShell = { exe: c, args: ['-NoLogo'] };
        return cachedShell;
      }
    }
    // Fallback : powershell.exe doit toujours être présent dans System32 — on
    // construit le path absolu plutôt que de retourner un nom nu (sinon node-pty
    // déclencherait la résolution PATH/PATHEXT, hasard de sécurité Windows).
    cachedShell = {
      exe: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo']
    };
    return cachedShell;
  }

  // POSIX : préfère $SHELL si absolu/safe et existant, fallback ordonné.
  // -l pour login shell (charge .zshrc/.bashrc).
  const fromEnv = process.env.SHELL;
  if (isSafeShellPath(fromEnv) && existsSync(fromEnv)) {
    cachedShell = { exe: fromEnv, args: ['-l'] };
    return cachedShell;
  }

  const macFallbacks = ['/bin/zsh', '/bin/bash'];
  const linuxFallbacks = ['/bin/bash', '/bin/sh'];
  const fallbacks = process.platform === 'darwin' ? macFallbacks : linuxFallbacks;
  for (const c of fallbacks) {
    if (existsSync(c)) {
      cachedShell = { exe: c, args: ['-l'] };
      return cachedShell;
    }
  }
  cachedShell = { exe: '/bin/sh', args: [] };
  return cachedShell;
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
