// Détection des URLs localhost dans la sortie d'un PTY.

// CSI complet : ESC [ <params> <intermediate> <final byte 0x40-0x7E>
// Couvre cursor-position (H/f), erase (J/K), SGR (m), DEC private (?), etc.
const ANSI_RE = /\x1b\[[\d;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()=][AB012]/g;

// Box drawing + braille + flèches + tirets typographiques + bullets.
const BOX_DRAWING_RE = /[─-▟⠀-⣿←-⇿•·▶▷▸▹►▻]/g;

// URL localhost. On limite le path à un segment simple (lowercase + chiffres + tirets/underscores)
// car les TUI d'agent (Claude Code, etc.) collent souvent du texte UI juste après l'URL,
// et après strip-ANSI les frontières de lignes disparaissent — un path trop permissif
// capture du vrai texte d'UI. La plupart des URLs de dev server intéressantes sont juste
// `host:port/` ou `host:port/segment`.
// Pas de flag `i` : on veut un path strictement lowercase pour ne pas baver
// sur du texte camelCase qui suit l'URL dans les TUI.
const URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[a-z0-9_\-./]{0,40})?/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(BOX_DRAWING_RE, ' ');
}

export function extractUrls(chunk: string): string[] {
  const clean = stripAnsi(chunk);
  const matches = clean.match(URL_RE);
  if (!matches) return [];
  // Trim ponctuation finale qui aurait été collée.
  // Trim ponctuation finale + segment final suspect ("/3" tout seul).
  const cleaned = matches
    .map((m) => m.replace(/[.,;:!?)\]}'`"]+$/, ''))
    .map((m) => m.replace(/\/[a-z0-9]{1,2}$/, '/'))
    .filter((m) => m.length > 7);
  return Array.from(new Set(cleaned));
}

/** Pousse les nouvelles URLs dans une liste LIFO bornée (10 max). */
export function mergeUrls(
  existing: string[] | undefined,
  fresh: string[]
): { merged: string[]; added: string[] } {
  const set = new Set(existing ?? []);
  const added: string[] = [];
  for (const u of fresh) {
    if (!set.has(u)) {
      set.add(u);
      added.push(u);
    }
  }
  if (added.length === 0) return { merged: existing ?? [], added: [] };
  const merged = [...(existing ?? []), ...added].slice(-10);
  return { merged, added };
}
