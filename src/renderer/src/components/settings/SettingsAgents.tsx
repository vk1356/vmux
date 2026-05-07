import type { JSX } from 'react';
import { ExternalLink } from 'lucide-react';
import type { AgentAvailability, AgentId, AgentPreset, AppSettings } from '@shared/types';
import { useT } from '../../i18n';

interface Props {
  settings: AppSettings;
  agents: AgentPreset[];
  agentAvailability: Record<string, AgentAvailability>;
  apply: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsAgents({ settings, agents, agentAvailability, apply }: Props): JSX.Element {
  const t = useT();

  const applyAgentOverride = async (
    id: AgentId,
    patch: Partial<{ command: string; args: string[] }>
  ): Promise<void> => {
    const overrides = {
      ...settings.agentOverrides,
      [id]: { ...settings.agentOverrides[id], ...patch }
    };
    await apply({ agentOverrides: overrides });
  };

  return (
    <>
      {agents.map((a) => {
        const av = agentAvailability[a.id];
        const override = settings.agentOverrides[a.id];
        const cmd = override?.command ?? a.command;
        const argsStr = (override?.args ?? a.args).join(' ');
        return (
          <div key={a.id} className="field">
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
                style={{ background: a.color }}
                aria-hidden
              />
              <span className="field-label" style={{ margin: 0 }}>
                {a.label}
              </span>
              {av && av.found ? (
                <span style={{ fontSize: 10, color: 'var(--success)' }}>
                  ✓ {av.resolvedPath}
                </span>
              ) : a.id !== 'shell' ? (
                <a
                  style={{ fontSize: 10, color: 'var(--warn)', cursor: 'pointer' }}
                  onClick={() => a.installUrl && window.cmux.dialog.openExternal(a.installUrl)}
                >
                  {t('agentNotInstalled')}{' '}
                  <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
                </a>
              ) : null}
            </div>
            <div className="input-group">
              <input
                className="input"
                style={{ flex: '0 0 30%' }}
                placeholder={t('agentCommandPlaceholder')}
                value={cmd}
                onChange={(e) => void applyAgentOverride(a.id, { command: e.target.value })}
              />
              <input
                className="input"
                placeholder={t('agentArgsPlaceholder')}
                value={argsStr}
                onChange={(e) =>
                  void applyAgentOverride(a.id, {
                    args: e.target.value.split(/\s+/).filter(Boolean)
                  })
                }
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
