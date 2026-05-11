/**
 * Détection heuristique des prompts qui attendent une réponse de l'utilisateur.
 * Utilisé par pty-manager pour déclencher le badge "needs-input" quand un agent
 * TUI (Claude Code, Codex, Aider…) bloque sur une confirmation.
 *
 * Extraction isolée de pty-manager.ts : aucune dépendance Electron, donc testable
 * sans monter de PtyManager — voir __tests__/needs-input-detect.test.ts si besoin.
 */

const NEEDS_INPUT_PATTERNS: RegExp[] = [
  // (y/n), (yes/no), [Y/n] et variantes
  /\((?:y\/n|yes\/no|Y\/N|yN|yn|Yn)\)/i,
  /\[(?:Y\/n|y\/N|yes\/no)\]/i,
  // Press any/enter key
  /press (?:any |enter |return )key/i,
  // Confirmations FR/EN — exige un terminator interrogatif/délimiteur en fin
  // de tail. Sans ça, on match "Confirmed.", "confirmed changes", etc. dans
  // de la sortie normale de l'agent.
  /(?:continuer|confirm|continue|proceed)\s*[?:]\s*$/im,
  // Claude Code & autres TUI : prompts numérotés "Do you want to proceed?"
  // suivis d'une liste numérotée. On match juste la phrase clé.
  /do you want to (?:proceed|continue)/i,
  /requires approval/i,
  // Cursor pointer ❯ devant un choix numéroté (typique de Claude Code)
  /❯\s+\d+\.\s/,
  // "Select..." / "Choose..."
  /(?:choose|select|pick) (?:an? )?(?:option|choice|value)/i,
  /enter (?:to continue|the value|your)/i
];

/** Limite la fenêtre — on regarde les 200 derniers chars seulement pour rester O(1). */
const SCAN_WINDOW = 200;

export function detectsNeedsInput(stripped: string): boolean {
  const tail = stripped.length > SCAN_WINDOW ? stripped.slice(-SCAN_WINDOW) : stripped;
  return NEEDS_INPUT_PATTERNS.some((re) => re.test(tail));
}
