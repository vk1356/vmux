import { useId, useMemo, type JSX } from 'react';
import type { AppSettings } from '@shared/types';
import { useLocale, useT } from '../../i18n';

interface Props {
  settings: AppSettings;
  apply: (patch: Partial<AppSettings>) => Promise<void>;
}

const SHELL_PRESETS = [
  { value: 'pwsh', label: 'PowerShell 7+ (pwsh)' },
  { value: 'powershell', label: 'Windows PowerShell 5 (powershell)' },
  { value: 'cmd', label: 'cmd.exe' },
  { value: 'bash', label: 'Git Bash (bash)' }
] as const;

export function SettingsTerminal({ settings, apply }: Props): JSX.Element {
  const t = useT();
  const locale = useLocale();
  const shellId = useId();
  const scrollbackId = useId();
  const copySelId = useId();
  const pasteRcId = useId();
  const webglId = useId();
  const webglPoolId = useId();
  const zeroCopyId = useId();

  const scrollbackFormatted = useMemo(
    () => new Intl.NumberFormat(locale).format(settings.scrollback),
    [locale, settings.scrollback]
  );

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={shellId}>
          {t('fieldShell')}
        </label>
        <select
          id={shellId}
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
        <label className="field-label" htmlFor={scrollbackId}>
          {t('fieldScrollback')} ({scrollbackFormatted} {t('scrollbackUnit')})
        </label>
        <input
          id={scrollbackId}
          type="range"
          min={1000}
          max={50000}
          step={1000}
          value={settings.scrollback}
          onChange={(e) => void apply({ scrollback: Number(e.target.value) })}
        />
      </div>
      <label className="checkbox-row" htmlFor={copySelId}>
        <input
          id={copySelId}
          type="checkbox"
          checked={settings.copyOnSelection}
          onChange={(e) => void apply({ copyOnSelection: e.target.checked })}
        />
        {t('fieldCopyOnSelect')}
      </label>
      <label className="checkbox-row" htmlFor={pasteRcId}>
        <input
          id={pasteRcId}
          type="checkbox"
          checked={settings.pasteOnRightClick}
          onChange={(e) => void apply({ pasteOnRightClick: e.target.checked })}
        />
        {t('fieldPasteRightClick')}
      </label>
      <label className="checkbox-row" htmlFor={webglId}>
        <input
          id={webglId}
          type="checkbox"
          checked={settings.webglRenderer}
          onChange={(e) => void apply({ webglRenderer: e.target.checked })}
        />
        {t('fieldWebgl')}
        <span className="hint" style={{ marginLeft: 8 }}>
          {t('fieldWebglHint')}
        </span>
      </label>
      <label className="row" htmlFor={webglPoolId}>
        <span>{t('fieldWebglPoolSize')}</span>
        <input
          id={webglPoolId}
          type="number"
          min={1}
          max={16}
          step={1}
          disabled={!settings.webglRenderer}
          value={settings.webglPoolSize ?? 6}
          onChange={(e) => {
            const n = Math.max(1, Math.min(16, Number(e.target.value) || 6));
            void apply({ webglPoolSize: n });
          }}
        />
        <span className="hint" style={{ marginLeft: 8 }}>
          {t('fieldWebglPoolSizeHint')}
        </span>
      </label>
      <label className="checkbox-row" htmlFor={zeroCopyId}>
        <input
          id={zeroCopyId}
          type="checkbox"
          checked={settings.experimentalZeroCopyIpc === true}
          onChange={(e) => void apply({ experimentalZeroCopyIpc: e.target.checked })}
        />
        {t('fieldZeroCopyIpc')}
        <span className="hint" style={{ marginLeft: 8 }}>
          {t('fieldZeroCopyIpcHint')}
        </span>
      </label>
    </>
  );
}
