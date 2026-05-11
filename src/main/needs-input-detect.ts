/**
 * Détection heuristique des prompts qui attendent une réponse de l'utilisateur.
 * Utilisé par pty-manager pour déclencher le badge "needs-input" quand un agent
 * TUI (Claude Code, Codex, Aider…) bloque sur une confirmation.
 *
 * Extraction isolée de pty-manager.ts : aucune dépendance Electron, donc testable
 * sans monter de PtyManager — voir __tests__/needs-input-detect.test.ts si besoin.
 *
 * Perf : on FUSIONNE toutes les alternatives en UNE regex (vs 10 séparées),
 * pour ne scanner le tail qu'une seule fois par chunk. NFA-based engine V8 →
 * une alternation est ~équivalente à 10 .test() séparés en CPU mais évite le
 * coût d'appel de fonction × 10 et le re-walk de la string × 10.
 *
 * Le flag `m` permet à `$` de matcher la fin de ligne (pour "Confirm?\n"),
 * et `i` rend l'ensemble case-insensitive (donc plus besoin de lister yN/Yn).
 */

const NEEDS_INPUT_RE = new RegExp(
  [
    // (y/n), (yes/no) — case-insensitive grâce au flag `i`
    '\\((?:y\\/n|yes\\/no)\\)',
    // [Y/n], [y/N], [yes/no]
    '\\[(?:y\\/n|yes\\/no)\\]',
    // Press any/enter/return key
    'press (?:any |enter |return )key',
    // Confirmations FR/EN — exige un terminator interrogatif/délimiteur en fin
    // de ligne (mode `m`). Sans ça, on match "Confirmed.", "confirmed changes", etc.
    '(?:continuer|confirm|continue|proceed)\\s*[?:]\\s*$',
    // Claude Code & autres TUI : prompts "Do you want to proceed?"
    'do you want to (?:proceed|continue)',
    'requires approval',
    // Cursor pointer ❯ devant un choix numéroté (typique de Claude Code)
    '❯\\s+\\d+\\.\\s',
    // "Select option" / "Choose option" / "Pick option"
    '(?:choose|select|pick) (?:an? )?(?:option|choice|value)',
    'enter (?:to continue|the value|your)'
  ].join('|'),
  'im'
);

/** Limite la fenêtre — on regarde les 200 derniers chars seulement pour rester O(1). */
const SCAN_WINDOW = 200;

export function detectsNeedsInput(stripped: string): boolean {
  if (!stripped) return false;
  const tail = stripped.length > SCAN_WINDOW ? stripped.slice(-SCAN_WINDOW) : stripped;
  // Reset lastIndex au cas où le flag `g` serait un jour ajouté (défensif).
  NEEDS_INPUT_RE.lastIndex = 0;
  return NEEDS_INPUT_RE.test(tail);
}
