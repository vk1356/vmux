import type { DetectedEvent, DetectedEventKind, PaneId } from '@shared/types';
import { stripAnsi } from './url-detector';

interface MatcherDef {
  kind: DetectedEventKind;
  re: RegExp;
}

// On limite chaque match à ~70 chars max, et on s'arrête aux caractères
// non-imprimables, aux box-drawing et au "·" pour éviter de baver sur le TUI
// suivant (les UI agent comme Claude Code mettent du texte juste après l'URL).
// Note : pas de \b final — il fait échouer les matches qui finissent par un chiffre.
const STOP = `[^\\n\\r│┃┄┈─┌┐└┘├┤┬┴┼·•⠀-⣿]`;

// Tous les matchers ont le flag `g` : un même chunk peut contenir plusieurs
// événements de natures différentes (server-ready + build-success arrivent
// souvent dans la même rafale de logs). Sans `g`, seul le premier serait détecté.
//
// Les quantifieurs `{0,70}` / `{0,50}` sont GREEDY mais bornés explicitement
// → pas de backtracking pathologique (l'engine ne dépasse jamais la borne).
// On a besoin du greedy pour capturer l'URL complète dans le tail d'un match
// server-ready ("Local: http://localhost:5173/ ready in 320ms") : un lazy
// s'arrêterait à 0 char et l'extraction d'URL en aval échouerait.
const MATCHERS: MatcherDef[] = [
  {
    kind: 'server-ready',
    re: new RegExp(
      `(?:listening on|local(?:host)?:?\\s*http|ready in|vite v[\\d.]+\\s+ready|server (?:started|running|listening)|app running on|nuxt 3? ready|\\*\\s*running on|app listening|http server on port\\s+\\d|listening at)${STOP}{0,70}`,
      'gi'
    )
  },
  {
    kind: 'build-success',
    re: new RegExp(
      `(?:build (?:successful|completed?|finished|done|succeeded)|✓\\s*compiled|webpack compiled successfully|compiled (?:successfully|with no errors))${STOP}{0,70}`,
      'gi'
    )
  },
  {
    kind: 'build-error',
    re: new RegExp(
      `(?:build failed|failed to compile|compilation (?:failed|error)|\\d+\\s+errors?(?!\\s*pass))${STOP}{0,70}`,
      'gi'
    )
  },
  {
    kind: 'test-results',
    re: new RegExp(
      `(\\d+)\\s+(?:tests?\\s+)?(?:passed|passing|failing|failed)${STOP}{0,50}`,
      'gi'
    )
  },
  {
    kind: 'agent-done',
    re: /(?:completed|finished|done\.?)\s+(?:in\s+\d|\(\d|after\s+\d|with\s+\d)/gi
  }
];

// Pré-compilation (anti-allocation par chunk) : utilisée pour extraire l'URL
// d'un match server-ready. Non-global → `.exec()` sur un message court.
const URL_IN_MESSAGE_RE = /https?:\/\/[^\s'"<>]+/;

// Bail-out fast-path : si AUCUN des mots-clés racine n'apparaît dans le chunk,
// on saute les 5 .matchAll() qui ré-itèrent tous le buffer. La majorité écrasante
// des chunks PTY d'un agent IA n'a aucun de ces tokens. indexOf est ~10x plus
// rapide que .test() sur un buffer de 100KB.
function hasAnyHint(text: string): boolean {
  // Test les marqueurs les plus discriminants en premier.
  return (
    text.indexOf('http') !== -1 ||
    text.indexOf('compiled') !== -1 ||
    text.indexOf('listening') !== -1 ||
    text.indexOf('ready') !== -1 ||
    text.indexOf('uild') !== -1 || // "build" / "Build" / "Building" (sans la majuscule)
    text.indexOf('ailed') !== -1 || // "failed" / "Failed"
    text.indexOf('error') !== -1 ||
    text.indexOf('Error') !== -1 ||
    text.indexOf('pass') !== -1 ||
    text.indexOf('ompleted') !== -1 || // "completed" / "Completed"
    text.indexOf('inished') !== -1 || // "finished" / "Finished"
    text.indexOf('done') !== -1 ||
    text.indexOf('Done') !== -1 ||
    text.indexOf('running on') !== -1 ||
    text.indexOf('ailing') !== -1 // "failing"
  );
}

interface DetectorState {
  /** Dernier message émis par kind. Anti-doublon. */
  last: Map<DetectedEventKind, { message: string; ts: number }>;
}

const states = new Map<PaneId, DetectorState>();
const DEDUP_WINDOW = 2_000;

/** Analyse un chunk brut. Renvoie les événements neufs (post-dedup). */
export function detectEvents(paneId: PaneId, chunk: string): DetectedEvent[] {
  return detectEventsFromStripped(paneId, stripAnsi(chunk));
}

/** Variante pour appelants qui ont déjà strippé — évite un strip redondant
 *  dans le hot path PTY (cf. pty-manager.ts onData). */
export function detectEventsFromStripped(paneId: PaneId, text: string): DetectedEvent[] {
  if (!text) return [];
  // Fast path : aucun token discriminant → skip les 5 regex.
  if (!hasAnyHint(text)) return [];

  let state = states.get(paneId);
  if (!state) {
    state = { last: new Map() };
    states.set(paneId, state);
  }

  const now = Date.now();
  const out: DetectedEvent[] = [];
  for (let i = 0; i < MATCHERS.length; i++) {
    const { kind, re } = MATCHERS[i];
    // exec-loop avec lastIndex : équivalent à matchAll mais sans wrapper
    // iterator (moins d'allocation par chunk vide).
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const trimmed = raw.trim();
      const message = trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed;
      const prev = state.last.get(kind);
      if (prev && prev.message === message && now - prev.ts < DEDUP_WINDOW) continue;
      state.last.set(kind, { message, ts: now });

      let url: string | undefined;
      if (kind === 'server-ready') {
        const um = URL_IN_MESSAGE_RE.exec(message);
        if (um) url = um[0];
      }
      out.push({ paneId, kind, message, url, timestamp: now });

      // Garde-fou anti-zero-width match (lookahead-only) : avance lastIndex
      // d'au moins 1 pour éviter une boucle infinie.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

export function clearDetector(paneId: PaneId): void {
  states.delete(paneId);
}
