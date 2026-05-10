import { describe, expect, it } from 'vitest';
// Importé depuis version-compare directement : auto-updater.ts importe Electron
// qui ne charge pas en environnement vitest (binaire natif).
import { isNewer } from '../version-compare';

describe('isNewer', () => {
  it('returns true when remote major > local major', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns true when remote minor > local minor', () => {
    expect(isNewer('0.4.0', '0.3.7')).toBe(true);
  });

  it('returns true when remote patch > local patch', () => {
    expect(isNewer('0.3.8', '0.3.7')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewer('0.3.7', '0.3.7')).toBe(false);
  });

  it('returns false when remote < local', () => {
    expect(isNewer('0.3.6', '0.3.7')).toBe(false);
    expect(isNewer('0.2.99', '0.3.0')).toBe(false);
  });

  it('handles missing trailing segments', () => {
    expect(isNewer('1.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', '1.0')).toBe(true);
  });

  it('handles pre-release suffixes', () => {
    // 1.0.0-beta.1 < 1.0.0 dans semver pur, mais notre parser splitte aussi
    // sur `-` et compare numériquement → "1.0.0-beta.1" devient [1,0,0,0,1].
    // Pour le flux GitHub Releases, on n'a quasi jamais ce cas — on documente
    // juste le comportement.
    expect(isNewer('1.0.1', '1.0.0-beta.1')).toBe(true);
  });

  it('rejects non-numeric segments to 0 without throwing', () => {
    expect(isNewer('1.0.0', 'abc')).toBe(true);
    expect(isNewer('abc', '1.0.0')).toBe(false);
  });
});
