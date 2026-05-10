import type { DetectedEvent, PaneId } from '@shared/types';

/**
 * Détecteur d'OSC (Operating System Command) escape sequences émises par les
 * agents/CLI pour signaler une notification. macOS via iTerm2/Ghostty/Kitty
 * supporte ces séquences nativement ; sur Windows Terminal le support est
 * partiel/absent. vMux les capture côté main process et les route vers le
 * service de notifications natives Windows déjà en place.
 *
 * Format OSC : `ESC ] Ps ; Pt ST` où :
 *  - `ESC ]` = `\x1b\x5d`
 *  - `Ps` = paramètre numérique (ex. 9, 52, 777)
 *  - `Pt` = payload texte
 *  - `ST` = string terminator, soit `BEL` (`\x07`), soit `ESC \` (`\x1b\x5c`)
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
 * Itère les OSC complets dans un chunk. Les OSC non terminés (terminateur
 * absent — chunk coupé en plein milieu) sont ignorés ; vu que pty-manager
 * agrège les chunks à 60Hz, c'est rare en pratique.
 *
 * On ne désencapsule PAS récursivement — un OSC ne peut pas en contenir un
 * autre selon l'ECMA-48.
 */
export function* parseOsc(chunk: string): Generator<RawOsc> {
  let i = 0;
  while (i < chunk.length) {
    const start = chunk.indexOf('\x1b]', i);
    if (start === -1) return;
    const dataStart = start + 2;
    // Cherche le terminateur le plus proche (BEL ou ST).
    const belIdx = chunk.indexOf('\x07', dataStart);
    const stIdx = chunk.indexOf('\x1b\\', dataStart);
    let endIdx: number;
    let endLen: number;
    if (belIdx === -1 && stIdx === -1) return; // OSC non terminé — abandon
    if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
      endIdx = belIdx;
      endLen = 1;
    } else {
      endIdx = stIdx;
      endLen = 2;
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
  // Fast path : la majorité des chunks PTY ne contiennent pas d'OSC.
  if (!chunk || chunk.indexOf('\x1b]') === -1) return [];

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
        title: msg.slice(0, MAX_TITLE_LEN),
        message: '',
        timestamp: ts
      });
    } else if (ps === '777') {
      // urxvt format : "notify;<title>;<body>". Le sous-type "notify" est le
      // seul qui nous intéresse — d'autres existent ("dynamic_color" etc.) mais
      // pas pour des notifs user.
      if (!pt.startsWith('notify;')) continue;
      const rest = pt.slice('notify;'.length);
      const semi = rest.indexOf(';');
      const title = (semi === -1 ? rest : rest.slice(0, semi)).trim();
      const body = semi === -1 ? '' : rest.slice(semi + 1).trim();
      if (!title) continue;
      out.push({
        paneId,
        kind: 'notify',
        title: title.slice(0, MAX_TITLE_LEN),
        message: body.slice(0, MAX_BODY_LEN),
        timestamp: ts
      });
    }
    // Autres `Ps` (52 clipboard, 4 color, 10/11 fg/bg, etc.) — ignorés ici.
  }

  return out;
}
