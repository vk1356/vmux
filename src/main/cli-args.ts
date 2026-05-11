// Mini parser CLI pour `vMux.exe new --agent X --prompt Y --cwd Z`.
//
// On utilise `util.parseArgs` (Node ≥ 18.3, stable Node ≥ 20) — pas de regex
// donc pas de risque de catastrophic backtracking, et la forme `--flag=value`,
// `--flag value` et `--` sont gérées nativement.
//
// Sur Windows, ConPTY/CreateProcess split l'argv côté OS : les chemins quotés
// (`"C:\Program Files\foo"`) arrivent déjà sous forme d'un seul argv slot sans
// les guillemets. On n'a donc pas à les déparser ici.

import { parseArgs, type ParseArgsConfig } from 'node:util';
import log from 'electron-log/main';
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

const PARSE_OPTIONS = {
  agent: { type: 'string', short: 'a' },
  prompt: { type: 'string', short: 'p' },
  cwd: { type: 'string', short: 'd' },
  name: { type: 'string', short: 'n' },
  help: { type: 'boolean', short: 'h' },
  hidden: { type: 'boolean' }
} as const satisfies NonNullable<ParseArgsConfig['options']>;

/** Parse argv pour extraire une commande vMux. Retourne {kind:'none'} si rien
 *  ne correspond — l'app boot normalement. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  // En prod : argv[0] = vMux.exe, argv[1] = first user arg.
  // En dev : argv contient electron + chemin script + args.
  // On filtre les artefacts (chemins .exe / .js / electron) AVANT parseArgs
  // pour qu'il ne les confonde pas avec des positionnels.
  const cleaned: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    // Skip les chemins absolus de l'interpréteur Electron en dev.
    if (i === 1 && (a.endsWith('.js') || a.endsWith('.exe') || a.endsWith('main/index.js'))) {
      continue;
    }
    cleaned.push(a);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: cleaned,
      options: PARSE_OPTIONS,
      strict: false, // tolère les flags inconnus — un mauvais flag ne doit pas crasher l'app
      allowPositionals: true
    });
  } catch (err) {
    // parseArgs throw si la valeur d'une option est manquante en mode strict.
    // strict:false évite ça, mais on garde un fallback défensif.
    log.warn('[cli] parseArgs failed', err);
    return { kind: 'none' };
  }

  const flags = parsed.values as {
    agent?: string;
    prompt?: string;
    cwd?: string;
    name?: string;
    help?: boolean;
    hidden?: boolean;
  };
  const positionals = parsed.positionals;

  if (flags.hidden) return { kind: 'hidden' };
  if (flags.help) return { kind: 'help' };

  // Première positionnelle non-interpréteur. parseArgs nous l'a déjà filtrée.
  const first = positionals[0]?.toLowerCase();
  if (!first) return { kind: 'none' };

  if (first === 'help') return { kind: 'help' };
  if (first === 'focus') return { kind: 'focus' };
  if (first !== 'new') return { kind: 'none' };

  const agent = flags.agent;
  if (!agent || !VALID_AGENTS.has(agent as AgentId)) {
    // Sans --agent valide on ne peut rien faire : on retourne 'none' pour que
    // l'app boot normalement (l'user verra le hero avec ses sessions).
    return { kind: 'none' };
  }

  return {
    kind: 'new',
    agentId: agent as AgentId,
    prompt: flags.prompt,
    cwd: flags.cwd,
    name: flags.name
  };
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
