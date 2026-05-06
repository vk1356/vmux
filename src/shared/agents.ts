import type { AgentPreset } from './types';

// Les commandes sont les binaires PATH attendus. Sous Windows, .cmd / .exe sont
// résolus automatiquement par PowerShell via PATHEXT.
export const DEFAULT_AGENTS: AgentPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Official Anthropic CLI — Claude coding agent',
    command: 'claude',
    args: [],
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

/**
 * Merge un preset avec son override utilisateur (configuré dans Settings).
 * Permet à l'utilisateur de remapper la commande (`claude` → `claude-dev`)
 * et d'injecter des env vars sans toucher au code.
 */
export function resolveAgent(
  id: string,
  overrides?: Record<string, AgentOverride | undefined>
): AgentPreset | undefined {
  const preset = findAgent(id);
  if (!preset) return undefined;
  const o = overrides?.[id];
  if (!o) return preset;
  return {
    ...preset,
    command: o.command ?? preset.command,
    args: o.args ?? preset.args,
    env: { ...(preset.env || {}), ...(o.env || {}) }
  };
}

