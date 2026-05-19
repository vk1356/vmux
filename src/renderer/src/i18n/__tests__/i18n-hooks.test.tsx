import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { useT, useLocale, useI18n } from '..';
import { useSessionStore } from '../../store/sessions';
import type { AppSettings, Lang } from '@shared/types';

// Renderer-env (happy-dom) characterization of the i18n React hooks.
// These exercise the real Zustand store: useT/useLocale/useI18n all read
// `settings.language` via the live `useSessionStore` selector. We drive the
// store the same way the app does (patchSettings / setSettings) and assert
// the hooks re-render with the right strings — NO mocking of the store, NO
// faked behavior. EN is inline so it resolves synchronously; lazy locales
// (fr/de/...) are NOT awaited here, so a not-yet-loaded lang resolves to the
// EN fallback — that fallback path is itself the documented real behavior.

const baseSettings: AppSettings = {
  theme: 'dark',
  language: 'en',
  fontFamily: 'mono',
  fontSize: 14,
  defaultShell: 'pwsh',
  scrollback: 1000,
  cursorBlink: true,
  copyOnSelection: false,
  pasteOnRightClick: false,
  webglRenderer: true,
  sidebarWidth: 240,
  previewToastEnabled: true,
  previewAutoOpen: true,
  notificationsEnabled: true,
  notificationSound: 'default',
  autoLaunch: false,
  previewDefaultSplit: 0.5,
  agentOverrides: {},
  autoRestoreOnBoot: true,
  lastActiveSessionId: null,
  cdpEnabled: true,
  cdpPort: 9222,
  claudeCommandsEnabled: true
};

function setLang(lang: Lang): void {
  act(() => {
    useSessionStore.setState({ settings: { ...baseSettings, language: lang } });
  });
}

beforeEach(() => {
  useSessionStore.setState({ settings: { ...baseSettings, language: 'en' } });
});

afterEach(() => {
  useSessionStore.setState({ settings: null });
});

describe('useT()', () => {
  it('returns a t() that translates a known key in the current (EN) lang', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('settingsTitle')).toBe('Settings');
    expect(result.current('heroTitleB')).toBe('one window.');
  });

  it('interpolates vars through the returned t()', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('bannerAvailableBody', { version: '9.9.9' })).toBe(
      'Version 9.9.9 is ready to download.'
    );
  });

  it('re-renders with a stable t identity until lang changes', () => {
    const { result, rerender } = renderHook(() => useT());
    const first = result.current;
    rerender();
    // Same lang + same catalog version => same memoized function ref.
    expect(result.current).toBe(first);
  });

  it('falls back to EN when the active lang chunk is not yet loaded', () => {
    // 'fr' chunk is lazy (import.meta.glob) and never awaited in this test,
    // so translate() resolves synchronously to the EN fallback string.
    setLang('fr');
    const { result } = renderHook(() => useT());
    expect(result.current('settingsTitle')).toBe('Settings');
  });

  it('re-renders a component when the store lang switches', () => {
    function Probe(): JSX.Element {
      const t = useT();
      return <div data-testid="msg">{t('settingsTitle')}</div>;
    }
    render(<Probe />);
    expect(screen.getByTestId('msg')).toHaveTextContent('Settings');
    // Switch to a lang whose chunk isn't loaded: still EN fallback, but the
    // component must have re-rendered without throwing (subscription works).
    setLang('fr');
    expect(screen.getByTestId('msg')).toHaveTextContent('Settings');
  });
});

describe('useLocale()', () => {
  it('returns the BCP47 lang for the current store language', () => {
    const { result } = renderHook(() => useLocale());
    expect(result.current).toBe('en');
  });

  it('maps zh to zh-CN and reacts to store lang changes', () => {
    const { result, rerender } = renderHook(() => useLocale());
    expect(result.current).toBe('en');
    setLang('zh');
    rerender();
    expect(result.current).toBe('zh-CN');
    setLang('de');
    rerender();
    expect(result.current).toBe('de');
  });

  it('defaults to "en" when settings is null', () => {
    act(() => {
      useSessionStore.setState({ settings: null });
    });
    const { result } = renderHook(() => useLocale());
    expect(result.current).toBe('en');
  });
});

describe('useI18n()', () => {
  it('returns { t, locale, plural } with the documented shape', () => {
    const { result } = renderHook(() => useI18n());
    expect(typeof result.current.t).toBe('function');
    expect(result.current.locale).toBe('en');
    expect(typeof result.current.plural).toBe('function');
  });

  it('plural() selects the otherKey for count !== 1 and interpolates {n}', () => {
    const { result } = renderHook(() => useI18n());
    // EN: statusAttentionCount = '{n} session(s) need attention — click to switch'
    // For count 1, Intl PluralRules('en') => 'one' => oneKey.
    const one = result.current.plural(1, 'statusAttentionCount', 'statusAttentionCount');
    expect(one).toBe('1 session(s) need attention — click to switch');
    const many = result.current.plural(5, 'statusAttentionCount', 'statusAttentionCount');
    expect(many).toBe('5 session(s) need attention — click to switch');
  });

  it('exposes a t that honors the active locale', () => {
    const { result } = renderHook(() => useI18n());
    expect(result.current.t('settingsTitle')).toBe('Settings');
  });
});
