import { useRef, useState, type JSX } from 'react';
import { X, Palette, Bot, Sliders, Bell, Download } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { SettingsAppearance } from './settings/SettingsAppearance';
import { SettingsTerminal } from './settings/SettingsTerminal';
import { SettingsNotifications } from './settings/SettingsNotifications';
import { SettingsAgents } from './settings/SettingsAgents';
import { SettingsAdvanced } from './settings/SettingsAdvanced';
import { SettingsUpdates } from './settings/SettingsUpdates';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'apparence' | 'terminal' | 'notifs' | 'agents' | 'updates' | 'avance';

export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const { settings, agents, agentAvailability, patchSettings } = useSessionStore(
    useShallow((s) => ({
      settings: s.settings,
      agents: s.agents,
      agentAvailability: s.agentAvailability,
      patchSettings: s.patchSettings
    }))
  );
  const [tab, setTab] = useState<Tab>('apparence');
  const [saving, setSaving] = useState(false);
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

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

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settingsTitle')}
        style={{ width: 'min(720px, 92vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="dialog-title">{t('settingsTitle')}</div>
          <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
            <X size={14} />
          </button>
        </div>

        <div className="settings-layout">
          <div className="settings-tabs">
            <SettingsTabButton
              label={t('tabAppearance')}
              icon={<Palette size={14} />}
              active={tab === 'apparence'}
              onClick={() => setTab('apparence')}
            />
            <SettingsTabButton
              label={t('tabTerminal')}
              icon={<Sliders size={14} />}
              active={tab === 'terminal'}
              onClick={() => setTab('terminal')}
            />
            <SettingsTabButton
              label={t('tabNotifications')}
              icon={<Bell size={14} />}
              active={tab === 'notifs'}
              onClick={() => setTab('notifs')}
            />
            <SettingsTabButton
              label={t('tabAgents')}
              icon={<Bot size={14} />}
              active={tab === 'agents'}
              onClick={() => setTab('agents')}
            />
            <SettingsTabButton
              label={t('tabUpdates')}
              icon={<Download size={14} />}
              active={tab === 'updates'}
              onClick={() => setTab('updates')}
            />
            <SettingsTabButton
              label={t('tabAdvanced')}
              icon={<Sliders size={14} />}
              active={tab === 'avance'}
              onClick={() => setTab('avance')}
            />
          </div>

          <div className="dialog-body" style={{ flex: 1, overflowY: 'auto' }}>
            {tab === 'apparence' && <SettingsAppearance settings={settings} apply={apply} />}
            {tab === 'terminal' && <SettingsTerminal settings={settings} apply={apply} />}
            {tab === 'notifs' && <SettingsNotifications settings={settings} apply={apply} />}
            {tab === 'agents' && (
              <SettingsAgents
                settings={settings}
                agents={agents}
                agentAvailability={agentAvailability}
                apply={apply}
              />
            )}
            {tab === 'updates' && <SettingsUpdates />}
            {tab === 'avance' && <SettingsAdvanced settings={settings} apply={apply} />}
          </div>
        </div>

        <div className="dialog-footer">
          <span className="hint" style={{ flex: 1 }}>
            {saving ? t('settingsSavingHint') : t('settingsLiveHint')}
          </span>
          <button className="btn primary" onClick={onClose}>
            {t('settingsClose')}
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
