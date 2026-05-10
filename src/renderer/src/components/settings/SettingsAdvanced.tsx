import type { JSX } from 'react';
import { ExternalLink, RotateCw } from 'lucide-react';
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
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoRestoreOnBoot}
            onChange={(e) => void apply({ autoRestoreOnBoot: e.target.checked })}
          />
          {t('fieldAutoRestore')}
        </label>
        <div className="hint">{t('fieldAutoRestoreHint')}</div>
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
        <label className="field-label">{t('fieldReplayTutorial')}</label>
        <button
          className="btn"
          onClick={async () => {
            await apply({ onboardingCompleted: false });
            // Reload pour redéclencher l'overlay (le useEffect de App.tsx
            // se base sur le settings — le re-trigger est plus fiable
            // qu'un setState manuel cross-component).
            window.location.reload();
          }}
        >
          <RotateCw size={11} /> {t('replayTutorialBtn')}
        </button>
        <div className="hint">{t('replayTutorialHint')}</div>
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
