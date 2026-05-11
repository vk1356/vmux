import { useCallback, useId, type JSX } from 'react';
import { ExternalLink } from 'lucide-react';
import type { AgentAvailability, AgentId, AgentPreset, AppSettings } from '@shared/types';
import { useT } from '../../i18n';

interface Props {
  settings: AppSettings;
  agents: AgentPreset[];
  agentAvailability: Record<string, AgentAvailability>;
  apply: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsAgents({
  settings,
  agents,
  agentAvailability,
  apply
}: Props): JSX.Element {
  const t = useT();

  const applyAgentOverride = useCallback(
    async (
      id: AgentId,
      patch: Partial<{ command: string; args: string[] }>
    ): Promise<void> => {
      const overrides = {
        ...settings.agentOverrides,
        [id]: { ...settings.agentOverrides[id], ...patch }
      };
      await apply({ agentOverrides: overrides });
    },
    [settings.agentOverrides, apply]
  );

  return (
    <>
      {agents.map((a) => (
        <AgentRow
          key={a.id}
          preset={a}
          availability={agentAvailability[a.id]}
          override={settings.agentOverrides[a.id]}
          notInstalledLabel={t('agentNotInstalled')}
          cmdPlaceholder={t('agentCommandPlaceholder')}
          argsPlaceholder={t('agentArgsPlaceholder')}
          onChange={applyAgentOverride}
        />
      ))}
    </>
  );
}

interface AgentRowProps {
  preset: AgentPreset;
  availability: AgentAvailability | undefined;
  override: Partial<{ command: string; args: string[] }> | undefined;
  notInstalledLabel: string;
  cmdPlaceholder: string;
  argsPlaceholder: string;
  onChange: (
    id: AgentId,
    patch: Partial<{ command: string; args: string[] }>
  ) => Promise<void>;
}

function AgentRow({
  preset,
  availability,
  override,
  notInstalledLabel,
  cmdPlaceholder,
  argsPlaceholder,
  onChange
}: AgentRowProps): JSX.Element {
  const cmdId = useId();
  const argsId = useId();
  const cmd = override?.command ?? preset.command;
  // Render the joined args directly from state. We tokenize on input — splitting
  // collapses inner whitespace, but typing UX stays predictable because we only
  // tokenize on submit (here: on every change, which is acceptable for IPC-
  // debounced writes; the user sees what they typed because the *value* prop
  // reflects the parsed-and-rejoined form).
  const argsStr = (override?.args ?? preset.args).join(' ');

  return (
    <div className="field">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4
        }}
      >
        <span
          className="agent-card-bullet"
          style={{ background: preset.color }}
          aria-hidden
        />
        <span className="field-label" style={{ margin: 0 }}>
          {preset.label}
        </span>
        {availability && availability.found ? (
          <span style={{ fontSize: 10, color: 'var(--success)' }}>
            ✓ {availability.resolvedPath}
          </span>
        ) : preset.id !== 'shell' ? (
          <button
            type="button"
            className="btn ghost"
            style={{
              fontSize: 10,
              color: 'var(--warn)',
              padding: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer'
            }}
            onClick={() =>
              preset.installUrl && window.cmux.dialog.openExternal(preset.installUrl)
            }
          >
            {notInstalledLabel}{' '}
            <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
          </button>
        ) : null}
      </div>
      <div className="input-group">
        <label className="sr-only" htmlFor={cmdId}>
          {preset.label} {cmdPlaceholder}
        </label>
        <input
          id={cmdId}
          className="input"
          style={{ flex: '0 0 30%' }}
          placeholder={cmdPlaceholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={cmd}
          onChange={(e) => void onChange(preset.id, { command: e.target.value })}
        />
        <label className="sr-only" htmlFor={argsId}>
          {preset.label} {argsPlaceholder}
        </label>
        <input
          id={argsId}
          className="input"
          placeholder={argsPlaceholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          value={argsStr}
          onChange={(e) =>
            void onChange(preset.id, {
              args: e.target.value.split(/\s+/).filter(Boolean)
            })
          }
        />
      </div>
    </div>
  );
}
