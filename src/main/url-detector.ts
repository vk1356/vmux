// Détection des URLs localhost dans la sortie d'un PTY.
//
// HOT PATH : ces fonctions traversent CHAQUE chunk PTY (cf. pty-manager onData).
// Toutes les RegExp sont compilées une seule fois au load du module — JAMAIS
// dans le corps d'une fonction appelée par chunk.

// ----------------------------------------------------------------------------
// ANSI stripping
// ----------------------------------------------------------------------------
//
// Couverture ECMA-48 / VT500 / xterm :
//   - CSI 7-bit   : ESC [ <params> <intermediates> <final 0x40-0x7E>
//   - CSI 8-bit   : 0x9B <params> <intermediates> <final 0x40-0x7E>
//   - OSC 7-bit   : ESC ] ... (BEL | ESC \ | 0x9C)
//   - OSC 8-bit   : 0x9D ... (BEL | ESC \ | 0x9C)
//   - DCS         : ESC P ... ST    (0x90 ... ST en 8-bit)
//   - SOS/PM/APC  : ESC X / ESC ^ / ESC _ ... ST
//   - Charset designators : ESC ( | ) | * | + | - | . | / <char>
//   - Single shifts / Fe escapes seuls : ESC <0x40-0x5F>
//   - String terminator nu (0x9C / ESC \) — rare mais doit être absorbé
//
// Pour les séquences "string" (OSC/DCS/SOS/PM/APC) on accepte plusieurs
// terminateurs car les agents/CLI sont incohérents (Claude Code BEL, codex ST,
// ConPTY relaye parfois brut). On borne le scan avec `{0,4096}` pour empêcher
// du backtracking pathologique sur un terminateur manquant — un OSC légitime
// ne dépasse jamais 2KB (cf. MAX_OSC_PAYLOAD dans osc-detector).
const ANSI_RE = new RegExp(
  [
    // CSI 7-bit + 8-bit
    '(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]',
    // OSC 7-bit + 8-bit + tous les terminateurs (BEL, ST 7-bit, ST 8-bit)
    '(?:\\x1b\\]|\\x9d)[\\x20-\\x7e]{0,4096}?(?:\\x07|\\x1b\\\\|\\x9c)',
    // DCS / SOS / PM / APC (string sequences)
    '(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[\\s\\S]{0,4096}?(?:\\x1b\\\\|\\x9c|\\x07)',
    // Charset designators : ESC <intermediate> <final>
    '\\x1b[()*+\\-./][\\x20-\\x7e]',
    // Fe / Fs / Fp escapes seuls (RI / NEL / DECSC / DECRC / etc.)
    '\\x1b[\\x40-\\x5f]',
    // ST nu (peut traîner après un OSC partiel)
    '\\x9c'
  ].join('|'),
  'g'
);

// Box drawing + braille + flèches + tirets typographiques + bullets.
// Remplacés par espace pour préserver la séparation visuelle des tokens.
const BOX_DRAWING_RE = /[─-▟⠀-⣿←-⇿•·▶▷▸▹►▻]/g;

// URL localhost. On limite le path à un segment simple (lowercase + chiffres + tirets/underscores)
// car les TUI d'agent (Claude Code, etc.) collent souvent du texte UI juste après l'URL,
// et après strip-ANSI les frontières de lignes disparaissent — un path trop permissif
// capture du vrai texte d'UI. La plupart des URLs de dev server intéressantes sont juste
// `host:port/` ou `host:port/segment`.
// Pas de flag `i` : on veut un path strictement lowercase pour ne pas baver
// sur du texte camelCase qui suit l'URL dans les TUI.
// Quantifieurs bornés ({1,5}, {0,40}) → pas de backtracking exponentiel.
const URL_RE =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[a-z0-9_\-./]{0,40})?/g;

// Trailing punctuation à virer après extraction (ponctuation de phrase qui
// colle à l'URL : "see http://localhost/." → "http://localhost/").
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'`"]+$/;
// Petits suffixes type "/3" issus du clipping path par TUI overlap — on
// rétrograde à "/" plutôt que de garder un segment tronqué.
const SHORT_TAIL_RE = /\/[a-z0-9]{1,2}$/;

export function stripAnsi(text: string): string {
  // Fast path : pas d'ESC ni de C1 (0x9b/0x9d) → aucun ANSI possible. On
  // saute le coûteux replace ANSI mais on doit toujours faire le box-drawing
  // (qui apparaît sans escape, ex. dans les box des spinners Claude Code).
  // replace() alloue toujours une string même sans match, donc on peut
  // appeler directement — V8 short-circuit quand 0 match avec une regex `g`
  // simple class-based, c'est ~free.
  if (text.indexOf('\x1b') < 0 && text.indexOf('\x9b') < 0 && text.indexOf('\x9d') < 0) {
    return text.replace(BOX_DRAWING_RE, ' ');
  }
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
  // exec-loop avec lastIndex évite l'allocation d'un array intermédiaire de
  // `match()` quand il y a 0 ou 1 URL (cas dominant). Avec dédup intégrée
  // via Set, on saute aussi le `.map().map().filter().Array.from(new Set())`.
  URL_RE.lastIndex = 0;
  let result: string[] | null = null;
  let seen: Set<string> | null = null;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(stripped)) !== null) {
    let url = m[0];
    if (TRAILING_PUNCT_RE.test(url)) url = url.replace(TRAILING_PUNCT_RE, '');
    if (SHORT_TAIL_RE.test(url)) url = url.replace(SHORT_TAIL_RE, '/');
    if (url.length <= 7) continue;
    if (result === null) {
      result = [url];
    } else {
      if (seen === null) {
        seen = new Set(result);
      }
      if (!seen.has(url)) {
        seen.add(url);
        result.push(url);
      }
    }
  }
  return result ?? [];
}

/** Pousse les nouvelles URLs dans une liste LIFO bornée (10 max). */
export function mergeUrls(
  existing: string[] | undefined,
  fresh: string[]
): { merged: string[]; added: string[] } {
  if (fresh.length === 0) return { merged: existing ?? [], added: [] };
  const existingArr = existing ?? [];
  const set = new Set(existingArr);
  const added: string[] = [];
  for (let i = 0; i < fresh.length; i++) {
    const u = fresh[i];
    if (!set.has(u)) {
      set.add(u);
      added.push(u);
    }
  }
  if (added.length === 0) return { merged: existingArr, added: [] };
  // Concat + slice — évite le spread qui alloue 2 fois.
  const merged = existingArr.concat(added);
  return {
    merged: merged.length > 10 ? merged.slice(merged.length - 10) : merged,
    added
  };
}
