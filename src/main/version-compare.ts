/** Compare deux versions semver-like. Retourne true ssi `remote > local`.
 *  Respecte la précédence semver pour les pré-releases :
 *    1.0.0 > 1.0.0-rc.1 > 1.0.0-beta.2 > 1.0.0-alpha
 *
 *  Sans cette logique, le coercion bête `parseInt('alpha') || 0` faisait passer
 *  `1.0.0-alpha` pour identique à `1.0.0` — donc une release pre-prod taguée
 *  par accident sur GitHub aurait été pushée à tous les users.
 *
 *  Fichier dédié sans dépendance Electron pour rester testable en pur Node.
 */

interface ParsedVersion {
  release: number[];      // [major, minor, patch, …]
  prerelease: string[];   // tokens après le '-', vide si stable
}

function parse(v: string): ParsedVersion {
  // Strip leading 'v' / 'V' que les tags GitHub utilisent souvent.
  const clean = v.replace(/^v/i, '').trim();
  // Sépare release et pré-release sur le PREMIER `-`. Build metadata (`+…`)
  // est ignoré pour la comparaison (semver §10).
  const plusIdx = clean.indexOf('+');
  const noBuild = plusIdx === -1 ? clean : clean.slice(0, plusIdx);
  const dashIdx = noBuild.indexOf('-');
  const releasePart = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx);
  const prePart = dashIdx === -1 ? '' : noBuild.slice(dashIdx + 1);
  const release = releasePart.split('.').map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const prerelease = prePart.length > 0 ? prePart.split('.') : [];
  return { release, prerelease };
}

/** Compare deux tokens de pré-release selon semver §11.4. */
function comparePrereleaseToken(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return parseInt(a, 10) - parseInt(b, 10);
  if (aNum) return -1;     // numérique a plus basse précédence qu'alphanum
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isNewer(remote: string, local: string): boolean {
  const r = parse(remote);
  const l = parse(local);
  // 1. Compare release numbers.
  const len = Math.max(r.release.length, l.release.length);
  for (let i = 0; i < len; i++) {
    const a = r.release[i] ?? 0;
    const b = l.release[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  // 2. Release égale : semver §11.3 — une version SANS prerelease est > qu'avec.
  if (r.prerelease.length === 0 && l.prerelease.length > 0) return true;
  if (r.prerelease.length > 0 && l.prerelease.length === 0) return false;
  // 3. Les deux ont une prerelease — compare token par token.
  const plen = Math.max(r.prerelease.length, l.prerelease.length);
  for (let i = 0; i < plen; i++) {
    const a = r.prerelease[i];
    const b = l.prerelease[i];
    if (a === undefined) return false;  // r est plus court → précédence plus basse
    if (b === undefined) return true;
    const cmp = comparePrereleaseToken(a, b);
    if (cmp > 0) return true;
    if (cmp < 0) return false;
  }
  return false;
}
