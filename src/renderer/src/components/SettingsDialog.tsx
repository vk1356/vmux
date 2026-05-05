import { useState, type JSX } from 'react';
import { X, Palette, Bot, Sliders, ExternalLink } from 'lucide-react';
import type { AgentId, AppSettings } from '@shared/types';
import { useSessionStore } from '../store/sessions';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'apparence' | 'agents' | 'avance';

const FONT_PRESETS = [
  '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  'Consolas, monospace',
  '"Courier New", monospace'
];

export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const { settings, agents, agentAvailability, patchSettings } = useSessionStore();
  const [tab, setTab] = useState<Tab>('apparence');
  const [saving, setSaving] = useState(false);

  if (!open || !settings) return null;

  const apply = async (patch: Partial<AppSettings>): Promise<void> => {
    setSaving(true);
    patchSettings(patch);
    try {
      await window.cmux.settings.set(patch);
    } finally {
      setSaving(false);
    }
  };

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
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        style={{ width: 'min(680px, 92vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="dialog-title">Paramètres</div>
          <button className="btn-icon" onClick={onClose} aria-label="Fermer">
            <X size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', minHeight: 380 }}>
          {/* Tabs */}
          <div
            style={{
              width: 160,
              borderRight: '1px solid var(--border)',
              padding: '12px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2
            }}
          >
            <SettingsTabButton
              label="Apparence"
              icon={<Palette size={14} />}
              active={tab === 'apparence'}
              onClick={() => setTab('apparence')}
            />
            <SettingsTabButton
              label="Agents"
              icon={<Bot size={14} />}
              active={tab === 'agents'}
              onClick={() => setTab('agents')}
            />
            <SettingsTabButton
              label="Avancé"
              icon={<Sliders size={14} />}
              active={tab === 'avance'}
              onClick={() => setTab('avance')}
            />
          </div>

          {/* Body */}
          <div className="dialog-body" style={{ flex: 1, overflowY: 'auto' }}>
            {tab === 'apparence' && (
              <>
                <div className="field">
                  <label className="field-label">Police</label>
                  <select
                    className="select"
                    value={settings.fontFamily}
                    onChange={(e) => void apply({ fontFamily: e.target.value })}
                  >
                    {FONT_PRESETS.map((f) => (
                      <option key={f} value={f}>
                        {f.split(',')[0].replace(/"/g, '')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">Taille de police ({settings.fontSize}px)</label>
                  <input
                    type="range"
                    min={10}
                    max={20}
                    step={1}
                    value={settings.fontSize}
                    onChange={(e) => void apply({ fontSize: Number(e.target.value) })}
                  />
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.cursorBlink}
                    onChange={(e) => void apply({ cursorBlink: e.target.checked })}
                  />
                  Curseur clignotant
                </label>
              </>
            )}

            {tab === 'agents' && (
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
                            onClick={() =>
                              a.installUrl && window.cmux.dialog.openExternal(a.installUrl)
                            }
                          >
                            non installé{' '}
                            <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
                          </a>
                        ) : null}
                      </div>
                      <div className="input-group">
                        <input
                          className="input"
                          style={{ flex: '0 0 30%' }}
                          placeholder="commande"
                          value={cmd}
                          onChange={(e) =>
                            void applyAgentOverride(a.id, { command: e.target.value })
                          }
                        />
                        <input
                          className="input"
                          placeholder="arguments séparés par espace"
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
                <div className="hint">
                  Les overrides sont sauvegardés mais ne sont pas encore appliqués au spawn (à venir).
                </div>
              </>
            )}

            {tab === 'avance' && (
              <>
                <div className="field">
                  <label className="field-label">
                    Scrollback ({settings.scrollback} lignes)
                  </label>
                  <input
                    type="range"
                    min={1000}
                    max={50000}
                    step={1000}
                    value={settings.scrollback}
                    onChange={(e) => void apply({ scrollback: Number(e.target.value) })}
                  />
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.copyOnSelection}
                    onChange={(e) => void apply({ copyOnSelection: e.target.checked })}
                  />
                  Copier la sélection automatiquement
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.pasteOnRightClick}
                    onChange={(e) => void apply({ pasteOnRightClick: e.target.checked })}
                  />
                  Coller au clic-droit
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.webglRenderer}
                    onChange={(e) => void apply({ webglRenderer: e.target.checked })}
                  />
                  Renderer WebGL (perf++)
                  <span className="hint" style={{ marginLeft: 8 }}>
                    redémarre l'app pour appliquer
                  </span>
                </label>

                <div className="field" style={{ marginTop: 8 }}>
                  <label className="field-label">Diagnostic</label>
                  <button
                    className="btn"
                    onClick={async () => {
                      const r = await window.cmux.diagnostic.export();
                      if (r.ok && r.data) {
                        // Le main ouvre déjà l'explorateur sur le fichier.
                      }
                    }}
                  >
                    Exporter le diagnostic (.json)
                  </button>
                  <div className="hint">
                    Génère un rapport (versions, agents, sessions, derniers logs) à fournir
                    en cas de bug. Les overrides agents sont anonymisés.
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <span className="hint" style={{ flex: 1 }}>
            {saving ? 'Sauvegarde…' : 'Modifications appliquées en live.'}
          </span>
          <button className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

interface TabBtnProps {
  label: string;
  icon: JSX.Element;
  active: boolean;
  onClick: () => void;
}

function SettingsTabButton({ label, icon, active, onClick }: TabBtnProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: active ? 'var(--bg-elev-2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        textAlign: 'left',
        fontSize: 13,
        fontWeight: active ? 500 : 400
      }}
    >
      {icon}
      {label}
    </button>
  );
}
