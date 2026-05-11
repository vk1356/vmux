/** Compare deux versions semver-like. Retourne true ssi `remote > local`.
 *  Respecte la précédence semver pour les pré-releases :
 *    1.0.0 > 1.0.0-rc.1 > 1.0.0-beta.2 > 1.0.0-alpha
 *
 *  Sans cette logique, le coercion bête `parseInt('alpha') || 0` faisait passer
 *  `1.0.0-alpha` pour identique à `1.0.0` — donc une release pre-prod taguée
 *  par accident sur GitHub aurait été pushée à tous les users.
 *
 *  Fichier dédié sans dépendance Electron pour rester testable en pur Node.
 *  Zero-dep volontaire — pas de `semver` lib pour garder le bundle main léger.
 */

/** Regex de validation d'un segment release : digits uniquement.
 *  `parseInt('1abc', 10)` retourne `1`, ce qu'on ne veut PAS — un segment
 *  malformé doit tomber sur 0 plutôt que d'être silencieusement tronqué. */
const NUMERIC_SEGMENT_RE = /^\d+$/;

/** Strip leading `v` / `V` que GitHub place devant ses tags (`v1.2.3`). */
const LEADING_V_RE = /^[vV]/;

interface ParsedVersion {
  /** Segments release (major, minor, patch, …). Tout non-numérique → 0. */
  readonly release: readonly number[];
  /** Tokens après le premier `-`, vide si stable. Build metadata stripée. */
  readonly prerelease: readonly string[];
}

function parse(v: string): ParsedVersion {
  if (typeof v !== 'string') return { release: [0], prerelease: [] };
  // Strip leading `v` / `V` + whitespace.
  const clean = v.replace(LEADING_V_RE, '').trim();
  if (clean.length === 0) return { release: [0], prerelease: [] };

  // Sépare release et pré-release sur le PREMIER `-`. Build metadata (`+…`)
  // est ignoré pour la comparaison (semver §10).
  const plusIdx = clean.indexOf('+');
  const noBuild = plusIdx === -1 ? clean : clean.slice(0, plusIdx);
  const dashIdx = noBuild.indexOf('-');
  const releasePart = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx);
  const prePart = dashIdx === -1 ? '' : noBuild.slice(dashIdx + 1);

  const release = releasePart.split('.').map((segment) => {
    // Validation stricte : tout segment non purement numérique → 0.
    // Évite `1abc.2.3` → `[1, 2, 3]` (bug de parseInt-tolerance).
    if (!NUMERIC_SEGMENT_RE.test(segment)) return 0;
    const parsed = Number.parseInt(segment, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });

  // Filtre les tokens vides éventuels (ex: `1.0.0-` → prePart='' → vide).
  const prerelease = prePart.length > 0 ? prePart.split('.').filter((t) => t.length > 0) : [];

  return { release, prerelease };
}

/** Compare deux tokens de pré-release selon semver §11.4 :
 *  - numeric < alphanumeric (numérique a précédence plus basse)
 *  - numeric vs numeric → numérique
 *  - alpha vs alpha → ASCII lex */
function comparePrereleaseToken(a: string, b: string): number {
  const aNum = NUMERIC_SEGMENT_RE.test(a);
  const bNum = NUMERIC_SEGMENT_RE.test(b);
  if (aNum && bNum) {
    const na = Number.parseInt(a, 10);
    const nb = Number.parseInt(b, 10);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Compare release-vectors segment par segment. */
function compareRelease(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Compare prerelease-vectors selon semver §11.4. */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // Semver §11.3 : une version SANS prerelease > une avec prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // a est plus court → précédence plus basse
    if (y === undefined) return 1;
    const cmp = comparePrereleaseToken(x, y);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** Retourne true ssi `remote` est strictement supérieur à `local`. */
export function isNewer(remote: string, local: string): boolean {
  const r = parse(remote);
  const l = parse(local);

  const releaseCmp = compareRelease(r.release, l.release);
  if (releaseCmp !== 0) return releaseCmp > 0;

  return comparePrerelease(r.prerelease, l.prerelease) > 0;
}
