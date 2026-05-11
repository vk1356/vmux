// Détection des URLs localhost dans la sortie d'un PTY.

// CSI complet : ESC [ <params> <intermediate> <final byte 0x40-0x7E>
// + OSC (ESC ] ... BEL/ST)
// + DCS (ESC P ... ST) / SOS (ESC X) / PM (ESC ^) / APC (ESC _)  — ConPTY/sixel les émet
// + Charset designators ESC ( / ) / =
// + Fe escapes seuls (ESC M, ESC E, ESC 7, ESC 8…) — RI/NEL/DECSC/DECRC
const ANSI_RE =
  /\x1b\[[\d;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x1b\\|\x07)|\x1b[()=][AB012]|\x1b[A-Z\\\]^_`]/g;

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
  // Hot path PTY (chaque chunk traverse cette fonction). 99% des chunks d'agent
  // n'ont pas d'URL — bail-out trivial avant le coûteux replace ANSI.
  if (chunk.indexOf('http') < 0) return [];
  return extractUrlsFromStripped(stripAnsi(chunk));
}

/** Variante quand l'appelant a déjà stripped — évite un strip redondant.
 *  Utilisée par pty-manager qui strip une seule fois en haut du onData. */
export function extractUrlsFromStripped(stripped: string): string[] {
  if (stripped.indexOf('http') < 0) return [];
  const matches = stripped.match(URL_RE);
  if (!matches) return [];
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
