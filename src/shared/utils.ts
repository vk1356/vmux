/** Quote pour un script PowerShell (single-quote escape).
 *  Utilisé par le builder de bootLine d'agent dans `main/shell.ts`. */
export function quotePsLiteral(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
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
