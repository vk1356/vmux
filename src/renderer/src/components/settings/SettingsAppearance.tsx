import { useId, useMemo, type JSX } from 'react';
import { Languages } from 'lucide-react';
import type { AppSettings, Lang } from '@shared/types';
import { LANG_LABELS, useT } from '../../i18n';

interface Props {
  settings: AppSettings;
  apply: (patch: Partial<AppSettings>) => Promise<void>;
}

const FONT_PRESETS = [
  '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  'Consolas, monospace',
  '"Courier New", monospace'
] as const;

export function SettingsAppearance({ settings, apply }: Props): JSX.Element {
  const t = useT();
  const langId = useId();
  const themeId = useId();
  const fontId = useId();
  const fontSizeId = useId();
  const cursorBlinkId = useId();

  const langOptions = useMemo(
    () =>
      (Object.keys(LANG_LABELS) as Lang[]).map((l) => (
        <option key={l} value={l}>
          {LANG_LABELS[l]}
        </option>
      )),
    []
  );

  const fontOptions = useMemo(
    () =>
      FONT_PRESETS.map((f) => (
        <option key={f} value={f}>
          {f.split(',')[0].replace(/"/g, '')}
        </option>
      )),
    []
  );

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={langId}>
          <Languages size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
          {t('fieldLanguage')}
        </label>
        <select
          id={langId}
          className="select"
          value={settings.language}
          onChange={(e) => void apply({ language: e.target.value as Lang })}
        >
          {langOptions}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={themeId}>
          {t('fieldTheme')}
        </label>
        <select
          id={themeId}
          className="select"
          value={settings.theme}
          onChange={(e) => void apply({ theme: e.target.value as AppSettings['theme'] })}
        >
          <option value="dark">{t('themeDark')}</option>
          <option value="light">{t('themeLight')}</option>
          <option value="system">{t('themeSystem')}</option>
        </select>
        <div className="hint">{t('themeLightHint')}</div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={fontId}>
          {t('fieldFont')}
        </label>
        <select
          id={fontId}
          className="select"
          value={settings.fontFamily}
          onChange={(e) => void apply({ fontFamily: e.target.value })}
        >
          {fontOptions}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={fontSizeId}>
          {t('fieldFontSize')} ({settings.fontSize}px)
        </label>
        <input
          id={fontSizeId}
          type="range"
          min={10}
          max={20}
          step={1}
          value={settings.fontSize}
          onChange={(e) => void apply({ fontSize: Number(e.target.value) })}
        />
      </div>
      <label className="checkbox-row" htmlFor={cursorBlinkId}>
        <input
          id={cursorBlinkId}
          type="checkbox"
          checked={settings.cursorBlink}
          onChange={(e) => void apply({ cursorBlink: e.target.checked })}
        />
        {t('fieldCursorBlink')}
      </label>
    </>
  );
}
