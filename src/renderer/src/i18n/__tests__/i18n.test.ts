import { describe, expect, it } from 'vitest';
import {
  translate,
  getNumberFormat,
  getPluralRules,
  getDateTimeFormat,
  getRelativeTimeFormat
} from '..';

// Characterization tests for the pure i18n engine surface.
// They encode the REAL observed behavior of src/renderer/src/i18n/index.ts.
// React hooks (useT/useLocale/useI18n) are intentionally NOT tested here —
// they require a renderer env and a live Zustand store.
//
// Real signature: translate(lang, key, vars?) -> string
// (NB: lang is the FIRST arg, not the last.)

describe('i18n translate() — catalog lookup', () => {
  it('returns the exact English string for a known EN key', () => {
    expect(translate('en', 'settingsTitle')).toBe('Settings');
    expect(translate('en', 'heroTitleB')).toBe('one window.');
  });

  it('falls back to EN for a lang whose chunk is not (yet) loaded', () => {
    // 'fr' is lazy-loaded via import.meta.glob and never awaited here, so the
    // loaded[] map only has 'en'. translate() resolves synchronously to EN.
    expect(translate('fr', 'settingsTitle')).toBe('Settings');
  });

  it('returns the raw key itself for a totally unknown key', () => {
    // No throw, no empty string — the key is surfaced verbatim for debugging.
    const unknown = 'this.key.does.not.exist' as unknown as Parameters<
      typeof translate
    >[1];
    expect(translate('en', unknown)).toBe('this.key.does.not.exist');
  });
});

describe('i18n translate() — interpolation', () => {
  it('substitutes a provided placeholder var', () => {
    // EN: bannerAvailableBody = 'Version {version} is ready to download.'
    expect(
      translate('en', 'bannerAvailableBody', { version: '1.2.3' })
    ).toBe('Version 1.2.3 is ready to download.');
  });

  it('coerces numeric vars to strings', () => {
    // EN: statusAttentionCount = '{n} session(s) need attention — click to switch'
    expect(translate('en', 'statusAttentionCount', { n: 3 })).toBe(
      '3 session(s) need attention — click to switch'
    );
  });

  it('leaves the {placeholder} literal in place when the var is MISSING', () => {
    // Observed real behavior: a missing/undefined var is NOT replaced with an
    // empty string — the original `{name}` token is preserved verbatim.
    expect(translate('en', 'bannerAvailableBody', {})).toBe(
      'Version {version} is ready to download.'
    );
  });

  it('returns the raw string untouched when no vars object is passed', () => {
    // translate() short-circuits before interpolate() when vars is undefined.
    expect(translate('en', 'bannerAvailableBody')).toBe(
      'Version {version} is ready to download.'
    );
  });
});

describe('i18n Intl helpers — usability + caching', () => {
  it('getNumberFormat returns a working NumberFormat and caches by args', () => {
    const a = getNumberFormat('en-US');
    const b = getNumberFormat('en-US');
    expect(a).toBeInstanceOf(Intl.NumberFormat);
    // Same locale + same (absent) options => SAME cached instance.
    expect(b).toBe(a);
    expect(a.format(1234.5)).toMatch(/1[,.\s]?234/);
    // Different options => different cache key => different instance.
    const c = getNumberFormat('en-US', { style: 'percent' });
    expect(c).not.toBe(a);
    expect(c.format(0.5)).toMatch(/50\s?%/);
  });

  it('getPluralRules returns working PluralRules and caches by args', () => {
    const a = getPluralRules('en-US');
    const b = getPluralRules('en-US');
    expect(a).toBeInstanceOf(Intl.PluralRules);
    expect(b).toBe(a);
    expect(a.select(1)).toBe('one');
    expect(a.select(5)).toBe('other');
  });

  it('getDateTimeFormat returns working DateTimeFormat and caches by args', () => {
    const a = getDateTimeFormat('en-US');
    const b = getDateTimeFormat('en-US');
    expect(a).toBeInstanceOf(Intl.DateTimeFormat);
    expect(b).toBe(a);
    expect(typeof a.format(new Date(2020, 0, 1))).toBe('string');
  });

  it('getRelativeTimeFormat returns working RelativeTimeFormat and caches by args', () => {
    const a = getRelativeTimeFormat('en-US');
    const b = getRelativeTimeFormat('en-US');
    expect(a).toBeInstanceOf(Intl.RelativeTimeFormat);
    expect(b).toBe(a);
    expect(a.format(-1, 'day')).toMatch(/day/);
  });
});
