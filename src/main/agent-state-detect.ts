/**
 * Détection heuristique de l'état "live" d'un agent IA dans le PTY.
 *
 * À la différence de `needs-input-detect.ts` qui ne signale qu'un besoin
 * d'interaction, ce détecteur retourne un état parmi :
 *   - `thinking`   : l'agent réfléchit (spinner Claude Code, "Thinking…", etc.)
 *   - `generating` : l'agent stream du texte / exécute un tool (output récent)
 *   - `needs-input`: l'agent attend une réponse user (réutilise needs-input-detect)
 *   - `idle`       : pas de spinner et pas d'output récent → l'agent est en pause
 *
 * Volontairement défensif :
 *   - Scan limité aux 800 derniers chars du tail stripped (O(1)).
 *   - Aucune dépendance à Electron / pty → testable unitairement.
 *
 * NB : la décision finale `idle` vs `generating` ne peut pas être prise par cette
 * fonction seule (il faut connaître le delta de temps depuis le dernier chunk).
 * Voir `pty-manager.ts` qui combine ce détecteur avec un timer d'inactivité.
 *
 * Perf : tous les patterns "thinking" sont FUSIONNÉS dans une seule regex
 * alternation — un seul scan du tail (800 chars max) par chunk, au lieu de 5
 * scans séquentiels. Engine V8 traite l'alternation en une passe NFA.
 */

import { detectsNeedsInput } from './needs-input-detect';

export type AgentRunState = 'idle' | 'thinking' | 'generating' | 'needs-input';

const SCAN_WINDOW = 800;

/**
 * Patterns de spinner "thinking" — couvre Claude Code, Codex, Cursor, Aider.
 *
 * Claude Code : `✻ Cogitating… (5s · esc to interrupt)` + variantes
 *   La liste de verbes est dynamique (Claude rotate), donc on match
 *   un mot capitalisé en `-ing` suivi d'une ellipse unicode `…` ou `...`,
 *   précédé par un glyphe d'animation typique. Pour éviter les faux positifs
 *   on exige aussi la présence d'un marqueur fort (`esc to interrupt` ou
 *   un glyphe de spinner).
 *
 * Le set de glyphes est dédoublonné (l'ancienne version avait `✻` deux fois).
 */
const SPINNER_GLYPHS = '[✻✶✢*·•○◔◑◕◐◓◒◧◨◩◪◫◰◱◲◳]';

/**
 * Regex fusionnée. Comporte plusieurs sous-patterns en alternation :
 *  1. `(esc to interrupt)` — marqueur le plus fiable de Claude Code (case-i).
 *  2. spinner glyph + Verb-ing + ellipsis (case-SENSITIVE — voir ci-dessous).
 *  3. "Thinking…" / "Thinking..." en début de ligne (case-SENSITIVE).
 *  4. Codex "Reasoning…" en début de ligne.
 *  5. Aider "Analyzing…" n'importe où (case-i).
 *
 * Pourquoi pas `i` global ? La capitalisation est un signal fort de spinner
 * (Claude/codex/cursor utilisent toujours Title-case "Thinking", la version
 * lowercase apparaît dans du texte cité par l'utilisateur → faux positifs).
 * On garde donc TWO regexes : une case-sensitive (patterns 2+3+4) et une
 * case-insensitive (patterns 1+5). Toujours plus efficace que 5 regex
 * séparées.
 */
const THINKING_CI_RE = /\(esc to interrupt\)|\bAnalyzing[….]{1,3}/i;

const THINKING_CS_RE = new RegExp(
  [
    // Glyphe de spinner + verbe-ing + ellipsis (Claude rotate ces verbes)
    `${SPINNER_GLYPHS}\\s+[A-Z][a-z]+ing[….]{1,3}`,
    // "Thinking…" en début de ligne (codex, cursor, claude)
    '(?:^|\\n)\\s*Thinking[….]{1,3}',
    // Codex CLI : "Reasoning…" / "Reasoning"
    '(?:^|\\n)\\s*Reasoning[….]{0,3}'
  ].join('|')
);

/** Détecte si le tail montre un spinner "thinking" actif. */
export function detectsThinking(tailStripped: string): boolean {
  if (!tailStripped) return false;
  const tail =
    tailStripped.length > SCAN_WINDOW ? tailStripped.slice(-SCAN_WINDOW) : tailStripped;
  // Test la regex la plus discriminante en premier (case-insensitive : moins
  // de patterns, mais l'un d'eux — "esc to interrupt" — est le marqueur le
  // plus fiable et le plus fréquent dans la pratique Claude Code).
  return THINKING_CI_RE.test(tail) || THINKING_CS_RE.test(tail);
}

/**
 * Décide l'état `live` d'un pane à partir du tail stripped + temps depuis le
 * dernier chunk PTY. La valeur de `IDLE_AFTER_MS` est calibrée à 2.5s — assez
 * long pour ne pas flasher idle entre deux frames du spinner, assez court pour
 * que l'utilisateur voie l'agent passer en idle dès qu'il finit.
 */
export const IDLE_AFTER_MS = 2500;

export interface DeriveStateInput {
  tailStripped: string;
  /** Ms depuis le dernier chunk PTY reçu (Date.now() - lastChunkAt). */
  msSinceLastChunk: number;
}

export function deriveAgentState(input: DeriveStateInput): AgentRunState {
  const { tailStripped, msSinceLastChunk } = input;
  // 1. needs-input l'emporte sur tout (l'agent est bloqué sur un prompt).
  if (detectsNeedsInput(tailStripped)) return 'needs-input';
  // 2. spinner "thinking" actif → l'agent réfléchit.
  if (detectsThinking(tailStripped)) return 'thinking';
  // 3. activité récente → l'agent stream du texte ou exécute un tool.
  if (msSinceLastChunk < IDLE_AFTER_MS) return 'generating';
  // 4. silence prolongé sans spinner → idle.
  return 'idle';
}
