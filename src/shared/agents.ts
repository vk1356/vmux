import type { AgentId, AgentPreset } from './types';

// Les commandes sont les binaires PATH attendus. Sous Windows, .cmd / .exe sont
// résolus automatiquement par PowerShell via PATHEXT.
//
// `satisfies AgentPreset[]` (au lieu de l'annotation directe) garde le tableau
// mutable pour les consumers qui acceptent `AgentPreset[]` (checkAgents…) tout
// en validant la conformité à la shape exacte.
export const DEFAULT_AGENTS: AgentPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Official Anthropic CLI — Claude coding agent',
    command: 'claude',
    // --dangerously-skip-permissions : auto-approve all tool prompts. vMux is
    // expected to be the user's main IDE-class harness for Claude Code (it
    // already isolates work in per-session git worktrees, so a misfire is
    // contained). Removable per-user via Settings → Agents → Claude Code args.
    args: ['--dangerously-skip-permissions'],
    color: '#d97706',
    installUrl: 'https://docs.claude.com/en/docs/claude-code/setup'
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex CLI',
    command: 'codex',
    args: [],
    color: '#10b981',
    installUrl: 'https://github.com/openai/codex'
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    description: 'Cursor CLI agent',
    command: 'cursor-agent',
    args: [],
    color: '#6366f1',
    installUrl: 'https://docs.cursor.com/en/cli'
  },
  {
    id: 'aider',
    label: 'Aider',
    description: 'AI pair programmer in your CLI',
    command: 'aider',
    args: [],
    color: '#ec4899',
    installUrl: 'https://aider.chat/docs/install.html'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'Google Gemini CLI',
    command: 'gemini',
    args: [],
    color: '#3b82f6',
    installUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Raw PowerShell, no agent',
    command: 'pwsh',
    args: [],
    color: '#71717a'
  }
];

export function findAgent(id: string): AgentPreset | undefined {
  return DEFAULT_AGENTS.find((a) => a.id === id);
}

export type AgentOverride = Partial<Pick<AgentPreset, 'command' | 'args' | 'env'>>;

/** Map d'overrides par agentId — typage strict côté key au lieu de `Record<string, …>`. */
export type AgentOverridesMap = Partial<Record<AgentId, AgentOverride>>;

/**
 * Merge un preset avec son override utilisateur (configuré dans Settings).
 * Permet à l'utilisateur de remapper la commande (`claude` → `claude-dev`)
 * et d'injecter des env vars sans toucher au code.
 */
export function resolveAgent(
  id: string,
  overrides?: AgentOverridesMap
): AgentPreset | undefined {
  const preset = findAgent(id);
  if (!preset) return undefined;
  const o = overrides?.[preset.id];
  if (!o) return preset;
  return {
    ...preset,
    command: o.command ?? preset.command,
    args: o.args ?? preset.args,
    env: { ...(preset.env ?? {}), ...(o.env ?? {}) }
  };
}
