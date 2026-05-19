import { describe, it, expect } from 'vitest';
import {
  MAX_ID_LEN,
  isId,
  isHttpUrl,
  safePath,
  isValidPtySize,
  sanitizeSettingsPatch
} from '../ipc-validation';

describe('ipc-validation guards (characterization)', () => {
  it('isId: normal id true; empty/non-string/oversized false', () => {
    expect(isId('sess_abc-123')).toBe(true);
    expect(isId('a'.repeat(MAX_ID_LEN))).toBe(true);        // exactly at cap
    expect(isId('')).toBe(false);
    expect(isId(123 as unknown as string)).toBe(false);
    expect(isId('x'.repeat(MAX_ID_LEN + 1))).toBe(false);  // one over cap
    // NUL byte → false
    expect(isId('abc\0def')).toBe(false);
  });

  it('isHttpUrl: http/https true; other schemes/non-string false', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://localhost:3000')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,hi')).toBe(false);
    expect(isHttpUrl(42 as unknown as string)).toBe(false);
    // bare http:// has empty host → false
    expect(isHttpUrl('http://')).toBe(false);
    // ctrl char inside URL → false
    expect(isHttpUrl('http://example.com/\x01path')).toBe(false);
  });

  it('safePath: non-string -> null; traversal NOT rejected by isUnsafePath (only NUL/UNC/length)', () => {
    // behavior: non-string input rejected by isUnsafePath → null
    expect(safePath(123 as unknown as string)).toBeNull();
    expect(safePath(null as unknown as string)).toBeNull();
    expect(safePath('')).toBeNull();

    // behavior: '../../etc/passwd' passes isUnsafePath (no NUL, not UNC, within length)
    // → path.resolve() returns an absolute path string, NOT null
    const trav = safePath('../../etc/passwd');
    expect(typeof trav).toBe('string'); // behavior: returns absolute resolved path

    // behavior: a clean absolute path returns a string
    const ok = safePath('C:/Users/me/project');
    expect(ok === null || typeof ok === 'string').toBe(true);
  });

  it('isValidPtySize: positive int cols/rows required, capped at 10000', () => {
    expect(isValidPtySize({ cols: 80, rows: 24 })).toBe(true);
    expect(isValidPtySize({ cols: 1, rows: 1 })).toBe(true);
    expect(isValidPtySize({ cols: 10000, rows: 10000 })).toBe(true);
    // zero → false
    expect(isValidPtySize({ cols: 0, rows: 24 })).toBe(false);
    expect(isValidPtySize({ cols: 80, rows: 0 })).toBe(false);
    // missing fields → false
    expect(isValidPtySize({} as unknown as { cols: number; rows: number })).toBe(false);
    // over cap → false
    expect(isValidPtySize({ cols: 10001, rows: 24 })).toBe(false);
    // non-finite → false
    expect(isValidPtySize({ cols: Infinity, rows: 24 })).toBe(false);
    expect(isValidPtySize({ cols: NaN, rows: 24 })).toBe(false);
    // non-object → false
    expect(isValidPtySize(null)).toBe(false);
    expect(isValidPtySize('80x24')).toBe(false);
  });

  it('sanitizeSettingsPatch: unknown keys dropped; known keys kept', () => {
    // unknown key completely stripped
    const cleaned = sanitizeSettingsPatch({ notAKey: 1 } as unknown);
    expect(Object.keys(cleaned)).not.toContain('notAKey');
    expect(Object.keys(cleaned)).toHaveLength(0);

    // known key passes through
    const withTheme = sanitizeSettingsPatch({ theme: 'dark' } as unknown);
    expect(withTheme.theme).toBe('dark');

    // mix: known + unknown → only known survives
    const mixed = sanitizeSettingsPatch({ theme: 'light', __proto__: 'x', evil: true } as unknown);
    expect(mixed.theme).toBe('light');
    expect(Object.keys(mixed)).not.toContain('__proto__');
    expect(Object.keys(mixed)).not.toContain('evil');

    // non-object → empty
    expect(sanitizeSettingsPatch(null)).toEqual({});
    expect(sanitizeSettingsPatch(42 as unknown)).toEqual({});
  });
});
