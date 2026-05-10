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

interface DetectorState {
  /** Dernier message émis par kind. Anti-doublon. */
  last: Map<DetectedEventKind, { message: string; ts: number }>;
}

const states = new Map<PaneId, DetectorState>();
const DEDUP_WINDOW = 2_000;

/** Analyse un chunk brut. Renvoie les événements neufs (post-dedup). */
export function detectEvents(paneId: PaneId, chunk: string): DetectedEvent[] {
  const text = stripAnsi(chunk);
  if (!text) return [];

  let state = states.get(paneId);
  if (!state) {
    state = { last: new Map() };
    states.set(paneId, state);
  }

  const now = Date.now();
  const out: DetectedEvent[] = [];
  for (const { kind, re } of MATCHERS) {
    // matchAll consomme le flag `g` ; chaque match est isolé. On déduplique
    // ensuite par message (pas par kind) pour qu'un même chunk puisse remonter
    // 2 builds successifs ou 2 servers démarrés sur des ports différents.
    for (const m of text.matchAll(re)) {
      const message = m[0].trim().slice(0, 160);
      const prev = state.last.get(kind);
      if (prev && prev.message === message && now - prev.ts < DEDUP_WINDOW) continue;
      state.last.set(kind, { message, ts: now });

      let url: string | undefined;
      if (kind === 'server-ready') {
        const um = message.match(/https?:\/\/[^\s'"<>]+/);
        if (um) url = um[0];
      }
      out.push({ paneId, kind, message, url, timestamp: now });
    }
  }
  return out;
}

export function clearDetector(paneId: PaneId): void {
  states.delete(paneId);
}
