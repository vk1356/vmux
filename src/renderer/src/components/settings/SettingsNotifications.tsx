import type { JSX } from 'react';
import { Globe, Music } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { useT } from '../../i18n';

interface Props {
  settings: AppSettings;
  apply: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsNotifications({ settings, apply }: Props): JSX.Element {
  const t = useT();
  return (
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
                  onClick={() => void apply({ notificationSoundPath: undefined })}
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
          onChange={(e) => void apply({ previewDefaultSplit: Number(e.target.value) })}
        />
        <div className="hint">{t('fieldPreviewSplitHint')}</div>
      </div>
    </>
  );
}
