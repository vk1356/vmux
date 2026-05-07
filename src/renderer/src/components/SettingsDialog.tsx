import { useEffect, useState, type JSX } from 'react';
import {
  X,
  Palette,
  Bot,
  Sliders,
  ExternalLink,
  Bell,
  Globe,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Languages,
  Music
} from 'lucide-react';
import type { AgentId, AppSettings, Lang, UpdateStatus } from '@shared/types';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { LANG_LABELS, useLocale, useT } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'apparence' | 'terminal' | 'notifs' | 'agents' | 'updates' | 'avance';

const FONT_PRESETS = [
  '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  'Consolas, monospace',
  '"Courier New", monospace'
];

const SHELL_PRESETS = [
  { value: 'pwsh', label: 'PowerShell 7+ (pwsh)' },
  { value: 'powershell', label: 'Windows PowerShell 5 (powershell)' },
  { value: 'cmd', label: 'cmd.exe' },
  { value: 'bash', label: 'Git Bash (bash)' }
];

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
  const locale = useLocale();

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
          {/* Tabs */}
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

          {/* Body */}
          <div className="dialog-body" style={{ flex: 1, overflowY: 'auto' }}>
            {tab === 'apparence' && (
              <>
                <div className="field">
                  <label className="field-label">
                    <Languages
                      size={11}
                      style={{ verticalAlign: '-1px', marginRight: 4 }}
                    />
                    {t('fieldLanguage')}
                  </label>
                  <select
                    className="select"
                    value={settings.language}
                    onChange={(e) =>
                      void apply({ language: e.target.value as Lang })
                    }
                  >
                    {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
                      <option key={l} value={l}>
                        {LANG_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">{t('fieldTheme')}</label>
                  <select
                    className="select"
                    value={settings.theme}
                    onChange={(e) =>
                      void apply({ theme: e.target.value as AppSettings['theme'] })
                    }
                  >
                    <option value="dark">{t('themeDark')}</option>
                    <option value="light">{t('themeLight')}</option>
                    <option value="system">{t('themeSystem')}</option>
                  </select>
                  <div className="hint">{t('themeLightHint')}</div>
                </div>
                <div className="field">
                  <label className="field-label">{t('fieldFont')}</label>
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
                  <label className="field-label">
                    {t('fieldFontSize')} ({settings.fontSize}px)
                  </label>
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
                  {t('fieldCursorBlink')}
                </label>
              </>
            )}

            {tab === 'terminal' && (
              <>
                <div className="field">
                  <label className="field-label">{t('fieldShell')}</label>
                  <select
                    className="select"
                    value={settings.defaultShell}
                    onChange={(e) => void apply({ defaultShell: e.target.value })}
                  >
                    {SHELL_PRESETS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <div className="hint">{t('fieldShellHint')}</div>
                </div>
                <div className="field">
                  <label className="field-label">
                    {t('fieldScrollback')} (
                    {new Intl.NumberFormat(locale).format(settings.scrollback)}{' '}
                    {t('scrollbackUnit')})
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
                  {t('fieldCopyOnSelect')}
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.pasteOnRightClick}
                    onChange={(e) => void apply({ pasteOnRightClick: e.target.checked })}
                  />
                  {t('fieldPasteRightClick')}
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.webglRenderer}
                    onChange={(e) => void apply({ webglRenderer: e.target.checked })}
                  />
                  {t('fieldWebgl')}
                  <span className="hint" style={{ marginLeft: 8 }}>
                    {t('fieldWebglHint')}
                  </span>
                </label>
              </>
            )}

            {tab === 'notifs' && (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.notificationsEnabled}
                    onChange={(e) => void apply({ notificationsEnabled: e.target.checked })}
                  />
                  {t('fieldNotifs')}
                </label>
                <div className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
                  {t('fieldNotifsHint')}
                </div>

                <div className="field" style={{ marginTop: 8 }}>
                  <label className="field-label">{t('fieldNotifSound')}</label>
                  <select
                    className="select"
                    value={settings.notificationSound}
                    onChange={(e) =>
                      void apply({
                        notificationSound: e.target.value as AppSettings['notificationSound']
                      })
                    }
                    disabled={!settings.notificationsEnabled}
                  >
                    <option value="default">{t('notifSoundDefault')}</option>
                    <option value="silent">{t('notifSoundSilent')}</option>
                    <option value="custom">{t('notifSoundCustom')}</option>
                  </select>
                  <div className="hint">{t('fieldNotifSoundHint')}</div>
                  {settings.notificationSound === 'custom' && (
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: 6,
                        flexWrap: 'wrap'
                      }}
                    >
                      <button
                        className="btn"
                        onClick={async () => {
                          const p = await window.cmux.dialog.pickSoundFile();
                          if (p) await apply({ notificationSoundPath: p });
                        }}
                      >
                        <Music size={11} /> {t('notifSoundPick')}
                      </button>
                      {settings.notificationSoundPath && (
                        <>
                          <code
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              flex: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                            title={settings.notificationSoundPath}
                          >
                            {t('notifSoundCurrent')} {settings.notificationSoundPath}
                          </code>
                          <button
                            className="btn ghost"
                            onClick={() =>
                              void apply({ notificationSoundPath: undefined })
                            }
                          >
                            {t('notifSoundClear')}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="dialog-section-title" style={{ marginTop: 16 }}>
                  <Globe size={12} /> {t('sectionPreviewLocalhost')}
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.previewToastEnabled}
                    onChange={(e) => void apply({ previewToastEnabled: e.target.checked })}
                  />
                  {t('fieldPreviewToast')}
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.previewAutoOpen}
                    onChange={(e) => void apply({ previewAutoOpen: e.target.checked })}
                  />
                  {t('fieldPreviewAutoOpen')}
                </label>
                <div className="field" style={{ marginTop: 8 }}>
                  <label className="field-label">
                    {t('fieldPreviewSplit')} ({settings.previewDefaultSplit}%)
                  </label>
                  <input
                    type="range"
                    min={30}
                    max={70}
                    step={5}
                    value={settings.previewDefaultSplit}
                    onChange={(e) =>
                      void apply({ previewDefaultSplit: Number(e.target.value) })
                    }
                  />
                  <div className="hint">{t('fieldPreviewSplitHint')}</div>
                </div>
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
                          onChange={(e) =>
                            void applyAgentOverride(a.id, { command: e.target.value })
                          }
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
            )}

            {tab === 'updates' && <UpdatesTab />}

            {tab === 'avance' && (
              <>
                <div className="field">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.autoLaunch}
                      onChange={(e) => void apply({ autoLaunch: e.target.checked })}
                    />
                    {t('fieldAutoLaunch')}
                  </label>
                  <div className="hint">{t('fieldAutoLaunchHint')}</div>
                </div>

                <div className="field">
                  <label className="field-label">{t('fieldDiagnostic')}</label>
                  <button
                    className="btn"
                    onClick={async () => {
                      await window.cmux.diagnostic.export();
                    }}
                  >
                    {t('diagnosticBtn')}
                  </button>
                  <div className="hint">{t('diagnosticHint')}</div>
                </div>
                <div className="field">
                  <label className="field-label">{t('fieldSource')}</label>
                  <button
                    className="btn"
                    onClick={() =>
                      window.cmux.dialog.openExternal('https://github.com/vk1356/vmux')
                    }
                  >
                    {t('sourceBtn')} <ExternalLink size={11} />
                  </button>
                </div>
              </>
            )}
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

/** Onglet Mises à jour : version actuelle, check manuel, statut live. */
function UpdatesTab(): JSX.Element {
  const t = useT();
  const [version, setVersion] = useState<string>('');
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    void window.cmux.app.version().then(setVersion);
    return window.cmux.updater.onStatus((s) => {
      setStatus(s);
      if (s.kind === 'checking') setCheckedAt(Date.now());
    });
  }, []);

  const onCheck = (): void => {
    setStatus({ kind: 'checking' });
    setCheckedAt(Date.now());
    void window.cmux.updater.check();
    setTimeout(() => {
      setStatus((cur) =>
        cur.kind === 'checking'
          ? {
              kind: 'error',
              code: 'no-response',
              message: 'No response from update server. Check your internet connection.'
            }
          : cur
      );
    }, 60000);
  };
  const onDownload = (): void => {
    void window.cmux.updater.download();
  };
  const onInstall = (): void => {
    void window.cmux.updater.install();
  };

  return (
    <>
      <div className="field">
        <label className="field-label">{t('fieldInstalledVersion')}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{ fontSize: 13, color: 'var(--text)' }}>vMux {version || '…'}</code>
        </div>
      </div>

      <div className="field">
        <label className="field-label">{t('fieldStatus')}</label>
        <UpdateStatusLine status={status} checkedAt={checkedAt} />
      </div>

      <div className="field" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn"
          onClick={onCheck}
          disabled={status.kind === 'checking' || status.kind === 'downloading'}
        >
          <RefreshCw
            size={12}
            className={status.kind === 'checking' ? 'spin' : undefined}
          />
          {t('updateCheck')}
        </button>
        {status.kind === 'available' && (
          <button className="btn primary" onClick={onDownload}>
            <Download size={12} /> {t('updateDownload')}{status.version}
          </button>
        )}
        {status.kind === 'downloaded' && (
          <button className="btn primary" onClick={onInstall}>
            <CheckCircle2 size={12} /> {t('updateInstall')}
          </button>
        )}
      </div>

      <div className="hint">{t('updateAutoHint')}</div>

      <div className="field" style={{ marginTop: 12 }}>
        <button
          className="btn"
          onClick={() =>
            window.cmux.dialog.openExternal('https://github.com/vk1356/vmux/releases')
          }
        >
          {t('updateSeeAll')} <ExternalLink size={11} />
        </button>
      </div>
    </>
  );
}

interface StatusLineProps {
  status: UpdateStatus;
  checkedAt: number | null;
}

function UpdateStatusLine({ status, checkedAt }: StatusLineProps): JSX.Element {
  const t = useT();
  switch (status.kind) {
    case 'idle':
      return <span style={{ color: 'var(--text-muted)' }}>{t('updateNoCheck')}</span>;
    case 'checking':
      return (
        <span style={{ color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={11} className="spin" /> {t('updateChecking')}
        </span>
      );
    case 'not-available':
      return (
        <span
          style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <CheckCircle2 size={11} /> {t('updateUpToDate')} (v{status.currentVersion})
          {checkedAt && ` — ${secondsAgo(checkedAt)}`}
        </span>
      );
    case 'available':
      return (
        <span style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Download size={11} /> {t('updateAvailable')} (v{status.version})
        </span>
      );
    case 'downloading': {
      const pct = Math.round(status.percent);
      const mbs = (status.bytesPerSecond / 1024 / 1024).toFixed(1);
      return (
        <span style={{ color: 'var(--info)' }}>
          {t('updateDownloading')} {pct}% — {mbs} MB/s
        </span>
      );
    }
    case 'downloaded':
      return (
        <span
          style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <CheckCircle2 size={11} /> {t('updateReady')} (v{status.version})
        </span>
      );
    case 'error':
      return (
        <span style={{ color: 'var(--error)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertTriangle size={11} /> {t('updateError')}: {translateUpdateError(t, status)}
        </span>
      );
  }
}

/** Traduit un message d'erreur d'update si on a un `code` connu, sinon affiche
 *  le message brut renvoyé par le main. */
function translateUpdateError(
  t: (k: import('../i18n').TKey) => string,
  status: Extract<UpdateStatus, { kind: 'error' }>
): string {
  switch (status.code) {
    case 'install-no-download':
      return t('errInstallNoDownload');
    case 'no-installer-url':
      return t('errNoInstallerUrl');
    case 'github-api-failed':
      return t('errGithubApiFailed');
    case 'no-response':
      return t('errNoResponse');
    case 'dev-mode':
      return t('errDevMode');
    default:
      return status.message;
  }
}

function secondsAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}
