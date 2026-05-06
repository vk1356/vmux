// Mini parser CLI pour `vMux.exe new --agent X --prompt Y --cwd Z`.
// Pas de dépendance externe — on parse à la main car le besoin est minimaliste.

import type { AgentId } from '@shared/types';

export type CliCommand =
  | { kind: 'none' }
  | {
      kind: 'new';
      agentId: AgentId;
      prompt?: string;
      cwd?: string;
      name?: string;
    }
  | { kind: 'focus' }
  | { kind: 'help' }
  | { kind: 'hidden' };

const VALID_AGENTS: ReadonlySet<AgentId> = new Set([
  'claude-code',
  'codex',
  'aider',
  'cursor-agent',
  'gemini',
  'shell'
]);

/** Parse argv pour extraire une commande vMux. Retourne {kind:'none'} si rien
 *  ne correspond — l'app boot normalement. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  // En prod : argv[0] = vMux.exe, argv[1] = first user arg.
  // En dev : argv contient electron + chemin script + args. On scan dans tous les cas.
  const args = argv.slice(1);
  // --hidden : flag passé par auto-launch Windows pour démarrer minimisé.
  if (args.includes('--hidden')) {
    return { kind: 'hidden' };
  }
  // Help peut être une commande positionnelle (`vmux help`) ou un flag global
  // (`vmux --help` / `vmux -h`). On gère les flags en premier car ils
  // seraient filtrés par `args.find` en-dessous.
  if (args.includes('--help') || args.includes('-h')) {
    return { kind: 'help' };
  }
  const first = args.find((a) => !a.startsWith('-') && !a.endsWith('.js') && !a.endsWith('.exe'));

  if (!first) return { kind: 'none' };
  const cmd = first.toLowerCase();

  if (cmd === 'help') {
    return { kind: 'help' };
  }
  if (cmd === 'focus') {
    return { kind: 'focus' };
  }
  if (cmd !== 'new') {
    return { kind: 'none' };
  }

  const agent = readFlag(args, '--agent', '-a');
  const prompt = readFlag(args, '--prompt', '-p');
  const cwd = readFlag(args, '--cwd', '-d');
  const name = readFlag(args, '--name', '-n');

  if (!agent || !VALID_AGENTS.has(agent as AgentId)) {
    // Sans --agent valide on ne peut rien faire : on retourne 'none' pour que
    // l'app boot normalement (l'user verra le hero avec ses sessions).
    return { kind: 'none' };
  }

  return {
    kind: 'new',
    agentId: agent as AgentId,
    prompt,
    cwd,
    name
  };
}

/** Lit une valeur de flag : `--foo bar` ou `--foo=bar`. */
function readFlag(args: readonly string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === long || a === short) {
      // Garde-fou : `vmux new --agent` (sans valeur) ou `--agent --prompt …`
      // (la valeur suivante est un autre flag) ⇒ on retourne undefined
      // pour que le parser remonte 'none' au lieu d'utiliser '--prompt' comme valeur d'agent.
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      return next;
    }
    if (a.startsWith(`${long}=`)) {
      return a.slice(long.length + 1);
    }
    if (short && a.startsWith(`${short}=`)) {
      return a.slice(short.length + 1);
    }
  }
  return undefined;
}

export const CLI_HELP = `vMux — Windows multi-agent AI orchestrator

Usage:
  vmux                              Open vMux (or focus the running window)
  vmux focus                        Focus the running window
  vmux new --agent <id> [options]   Create a new session

Agents:
  claude-code  codex  aider  cursor-agent  gemini  shell

Options for 'new':
  --agent, -a <id>      Agent ID (required)
  --prompt, -p <text>   Initial prompt sent to the agent
  --cwd, -d <path>      Working directory (default: current dir)
  --name, -n <name>     Session name (default: derived from cwd)

Examples:
  vmux new --agent claude-code --prompt "fix the auth bug"
  vmux new -a codex -d "C:\\repos\\my-app" -p "add tests for utils.ts"
  vmux new --agent shell --cwd .
`;
