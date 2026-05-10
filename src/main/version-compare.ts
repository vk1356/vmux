/** Compare deux versions semver-like. Retourne true ssi `remote > local`.
 *  Tolère les pré-releases simples séparées par `-` (chaque token devient
 *  un segment numérique ; les non-numériques deviennent 0 → équivaut à un
 *  tag final stable, ce qui suffit pour notre flux update GitHub).
 *
 *  Fichier dédié sans dépendance Electron pour rester testable en pur Node
 *  (vitest) — auto-updater.ts importe Electron qui ne charge pas en environnement
 *  node de test.
 */
export function isNewer(remote: string, local: string): boolean {
  const parse = (v: string): number[] => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const r = parse(remote);
  const l = parse(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] ?? 0;
    const b = l[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}
