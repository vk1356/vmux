import type { DetectedEvent, PaneId } from '@shared/types';

/**
 * Détecteur d'OSC (Operating System Command) escape sequences émises par les
 * agents/CLI pour signaler une notification. macOS via iTerm2/Ghostty/Kitty
 * supporte ces séquences nativement ; sur Windows Terminal le support est
 * partiel/absent. vMux les capture côté main process et les route vers le
 * service de notifications natives Windows déjà en place.
 *
 * Format OSC : `<OSC-introducer> Ps ; Pt <ST>` où :
 *  - OSC introducer  : `ESC ]` (7-bit, 0x1b 0x5d) OU `0x9d` (8-bit C1)
 *  - `Ps`            : paramètre numérique (ex. 9, 52, 777)
 *  - `Pt`            : payload texte
 *  - String Terminator : `BEL` (0x07), `ESC \` (0x1b 0x5c) OU `0x9c` (8-bit C1)
 *
 * Séquences supportées :
 *  - **OSC 9** (iTerm2 growl)        : `\x1b]9;<message>\x07`
 *  - **OSC 777** (urxvt notify-send) : `\x1b]777;notify;<title>;<body>\x07`
 *
 * Non gérées (skip explicite) :
 *  - **OSC 9;4** (iTerm progress)    : `\x1b]9;4;<state>;<percent>\x07` —
 *    barre de progression dans la title bar, pas une notif user.
 *  - **OSC 52** (clipboard)          : géré séparément si activé.
 */

/** Limite défensive sur le payload d'un OSC — au-delà on suppose une corruption
 *  ou un agent qui a leak un binaire dans le terminal. */
const MAX_OSC_PAYLOAD = 2048;

/** Tronque les titres pour ne pas exploser le toast Windows (qui n'affiche
 *  que ~64 chars en titre de toute façon). */
const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 240;

interface RawOsc {
  ps: string;
  pt: string;
}

/**
 * Cherche le prochain introducer OSC à partir de `from`. Renvoie l'index du
 * char qui débute la séquence (`ESC` ou `0x9d`), et la longueur de
 * l'introducer (2 pour `ESC ]`, 1 pour `0x9d`).
 */
function nextOscIntroducer(s: string, from: number): { idx: number; len: number } | null {
  let best = -1;
  let bestLen = 0;
  // ESC ] (7-bit)
  const i7 = s.indexOf('\x1b]', from);
  if (i7 !== -1) {
    best = i7;
    bestLen = 2;
  }
  // 0x9d (8-bit C1) — rare mais conforme ECMA-48
  const i8 = s.indexOf('\x9d', from);
  if (i8 !== -1 && (best === -1 || i8 < best)) {
    best = i8;
    bestLen = 1;
  }
  if (best === -1) return null;
  return { idx: best, len: bestLen };
}

/**
 * Itère les OSC complets dans un chunk. Les OSC non terminés (terminateur
 * absent — chunk coupé en plein milieu) sont ignorés ; vu que pty-manager
 * agrège les chunks à 60Hz, c'est rare en pratique.
 *
 * Terminateurs acceptés : BEL (0x07), ST 7-bit (ESC \\ = 0x1b 0x5c), ST 8-bit (0x9c).
 *
 * On ne désencapsule PAS récursivement — un OSC ne peut pas en contenir un
 * autre selon l'ECMA-48.
 */
export function* parseOsc(chunk: string): Generator<RawOsc> {
  let i = 0;
  const n = chunk.length;
  while (i < n) {
    const intro = nextOscIntroducer(chunk, i);
    if (intro === null) return;
    const dataStart = intro.idx + intro.len;
    // Single-pass terminator search. Avant : 3 indexOf séquentiels (BEL, ST 7-bit,
    // ST 8-bit) — chaque indexOf scanne le buffer entier jusqu'à un hit. Ici on
    // scanne UNE seule fois et on s'arrête au premier terminateur rencontré.
    // Pour un chunk de 100KB sans terminateur, ça remplace 300KB scannés par 100KB.
    let endIdx = -1;
    let endLen = 0;
    for (let j = dataStart; j < n; j++) {
      const c = chunk.charCodeAt(j);
      if (c === 0x07) {
        // BEL
        endIdx = j;
        endLen = 1;
        break;
      }
      if (c === 0x9c) {
        // ST 8-bit
        endIdx = j;
        endLen = 1;
        break;
      }
      if (c === 0x1b && j + 1 < n && chunk.charCodeAt(j + 1) === 0x5c) {
        // ESC \ (ST 7-bit)
        endIdx = j;
        endLen = 2;
        break;
      }
    }
    if (endIdx === -1) return; // OSC non terminé — abandon
    // Si un nouvel introducer OSC apparaît avant le terminateur trouvé, le
    // courant est unterminated (son terminateur a été "volé" par un OSC plus
    // tardif dans le chunk). On avance après l'introducer courant pour ressayer
    // sur l'OSC suivant — sinon on extrairait un payload corrompu spanning
    // deux OSC, perdant la notification réelle.
    const nextIntroIn = nextOscIntroducer(chunk, dataStart);
    if (nextIntroIn !== null && nextIntroIn.idx < endIdx) {
      i = dataStart;
      continue;
    }
    const rawLen = endIdx - dataStart;
    if (rawLen > MAX_OSC_PAYLOAD) {
      // Skip suspiciously large payload (probable binaire/leak), avance après terminateur.
      i = endIdx + endLen;
      continue;
    }
    const payload = chunk.slice(dataStart, endIdx);
    const semi = payload.indexOf(';');
    const ps = semi === -1 ? payload : payload.slice(0, semi);
    const pt = semi === -1 ? '' : payload.slice(semi + 1);
    yield { ps, pt };
    i = endIdx + endLen;
  }
}

/**
 * Convertit les OSC d'un chunk en `DetectedEvent[]` avec `kind: 'notify'`.
 * Le `paneId` est attaché à chaque event pour que le routage multi-agent
 * fonctionne en aval (notification-service utilise paneId pour retrouver
 * la session+agent et focus le bon pane au clic).
 */
export function detectOscEvents(paneId: PaneId, chunk: string): DetectedEvent[] {
  // Fast path : la majorité des chunks PTY ne contiennent aucun OSC. On teste
  // les deux introducers (7-bit + 8-bit) en O(n) via indexOf — bien plus
  // rapide qu'instancier le générateur pour rien.
  if (!chunk) return [];
  if (chunk.indexOf('\x1b]') === -1 && chunk.indexOf('\x9d') === -1) return [];

  const out: DetectedEvent[] = [];
  const ts = Date.now();

  for (const { ps, pt } of parseOsc(chunk)) {
    if (ps === '9') {
      // OSC 9;4;... = iTerm progress, pas une notif. On skip.
      if (pt === '4' || pt.startsWith('4;')) continue;
      const msg = pt.trim();
      if (!msg) continue;
      out.push({
        paneId,
        kind: 'notify',
        title: msg.length > MAX_TITLE_LEN ? msg.slice(0, MAX_TITLE_LEN) : msg,
        message: '',
        timestamp: ts
      });
    } else if (ps === '777') {
      // urxvt format : "notify;<title>;<body>". Le sous-type "notify" est le
      // seul qui nous intéresse — d'autres existent ("dynamic_color" etc.) mais
      // pas pour des notifs user.
      if (!pt.startsWith('notify;')) continue;
      const rest = pt.slice(7); // 'notify;'.length === 7
      const semi = rest.indexOf(';');
      const titleRaw = semi === -1 ? rest : rest.slice(0, semi);
      const title = titleRaw.trim();
      if (!title) continue;
      const bodyRaw = semi === -1 ? '' : rest.slice(semi + 1);
      const body = bodyRaw.trim();
      out.push({
        paneId,
        kind: 'notify',
        title: title.length > MAX_TITLE_LEN ? title.slice(0, MAX_TITLE_LEN) : title,
        message: body.length > MAX_BODY_LEN ? body.slice(0, MAX_BODY_LEN) : body,
        timestamp: ts
      });
    }
    // Autres `Ps` (52 clipboard, 4 color, 10/11 fg/bg, etc.) — ignorés ici.
  }

  return out;
}
