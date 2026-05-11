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

  it('handles pre-release suffixes per semver precedence', () => {
    // semver §11 : 1.0.0 > 1.0.0-rc.1 > 1.0.0-beta > 1.0.0-alpha
    expect(isNewer('1.0.1', '1.0.0-beta.1')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0-alpha')).toBe(true); // stable > prerelease
    expect(isNewer('1.0.0-alpha', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0-beta', '1.0.0-alpha')).toBe(true);
    expect(isNewer('1.0.0-alpha.2', '1.0.0-alpha.1')).toBe(true);
    // Le cas critique : ne PAS pousser un alpha comme update à un user stable.
    expect(isNewer('2.0.0-alpha', '1.9.9')).toBe(true); // major bump l'emporte
    expect(isNewer('0.7.3-alpha', '0.7.2')).toBe(true); // patch bump prerelease > stable précédent
  });

  it('strips leading v from GitHub tags', () => {
    expect(isNewer('v2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('V0.7.3', '0.7.2')).toBe(true);
  });

  it('ignores build metadata (+...)', () => {
    expect(isNewer('1.0.0+build.1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.0+build.1')).toBe(false);
  });

  it('rejects non-numeric segments to 0 without throwing', () => {
    expect(isNewer('1.0.0', 'abc')).toBe(true);
    expect(isNewer('abc', '1.0.0')).toBe(false);
  });
});
