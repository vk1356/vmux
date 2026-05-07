import type { JSX } from 'react';
import { ExternalLink } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { useT } from '../../i18n';

interface Props {
  settings: AppSettings;
  apply: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsAdvanced({ settings, apply }: Props): JSX.Element {
  const t = useT();
  return (
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
          onClick={() => window.cmux.dialog.openExternal('https://github.com/vk1356/vmux')}
        >
          {t('sourceBtn')} <ExternalLink size={11} />
        </button>
      </div>
    </>
  );
}
