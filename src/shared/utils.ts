/** Quote pour un script PowerShell (single-quote escape).
 *  Utilisé par le builder de bootLine d'agent dans `main/shell.ts`. */
export function quotePsLiteral(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote pour un shell POSIX (bash/zsh/sh) : single-quote enveloppant + escape
 *  des single-quotes via la séquence `'\''`. Utilisé sur macOS/Linux pour le
 *  bootLine des agents. */
export function quoteShLiteral(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Polyfill cross-platform pour requestIdleCallback (renderer-only en pratique). */
export function whenIdle(cb: () => void, fallbackMs = 200): void {
  const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void) => void };
  if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(cb);
  else setTimeout(cb, fallbackMs);
}

/** Récupère le basename d'un path Windows ou POSIX. */
export function pathBasename(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** Clamp une valeur entre min et max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** UUID v4. Node 20+ et Electron 28+ renderer ont `crypto.randomUUID()`
 *  unconditionally. vMux cible Electron 42 + Node 20 donc le fallback Math.random
 *  est code mort. Kept tight, no defensive fallbacks. */
export function uuid(): string {
  return crypto.randomUUID();
}

/** Extrait l'host d'une URL HTTP(S) pour affichage compact (TabBar, PaneHeader).
 *  Retourne les 24 premiers chars de l'URL en fallback si parse échoue. */
export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 24);
  }
}
