import { app } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Version logique du contenu du slash-command. Bump quand on change le prompt
 * pour que les installs précédentes soient écrasées (uniquement si elles n'ont
 * pas été éditées à la main par l'user — détecté via le marker en tête de fichier).
 */
const COMMAND_VERSION = 1;
const COMMAND_MARKER = `<!-- vmux-orchestrate version=${COMMAND_VERSION} — DO NOT REMOVE this marker; if you edit this file vMux will stop overwriting it on update -->`;
const VERSION_RE = /<!-- vmux-orchestrate version=(\d+)/;

/** Borne dure sur la taille du fichier slash-command qu'on accepte de lire.
 *  Le fichier généré fait ~3 Ko. 1 Mo couvre toutes les éditions raisonnables
 *  et empêche une bombe (symlink → /dev/zero, fichier géant) de spinner le
 *  main process pendant l'install au boot. */
const MAX_EXISTING_BYTES = 1024 * 1024;

const SLASH_COMMAND_BODY = `---
description: Decompose a task into N independent units and spawn a Claude Code agent in a new vMux pane for each.
argument-hint: <high-level task description>
---

${COMMAND_MARKER}

You are running **inside a vMux session**. The user invoked \`/vmux:orchestrate\` to fan a task out across multiple parallel Claude Code agents, each in its own vMux pane (each isolated in its own git worktree by default).

## Your job

1. **Read the user's task** — provided in \`$ARGUMENTS\`. If empty, ask the user what they want to orchestrate, then stop and wait.

2. **Analyze the repo** quickly (≤ 5 tool calls) to understand the scope. Use \`Glob\`, \`Read\` on a few key files, \`Bash\` on \`git status\` / \`git log -5\` if helpful.

3. **Decompose the task into 2–6 independent units** that can run in parallel without stepping on each other. Each unit should:
   - Have a clear, concrete deliverable (one file, one feature, one test suite, one refactor).
   - Be **independent** of the others — no shared edits to the same file. If two units touch the same file, merge them or sequence them.
   - Fit in a 5–15 minute Claude Code run.

4. **Present the plan** to the user as a numbered list. **Stop and ask for confirmation before spawning anything.** Format:
   \`\`\`
   I'll spawn N agents:
     1. <label> — <one-line task>
     2. <label> — <one-line task>
     ...
   Confirm with "go" to spawn, or tell me what to change.
   \`\`\`

5. **On user confirmation**, spawn each unit with the vMux CLI. The current working directory is the project root. Use:
   \`\`\`bash
   vmux new --agent claude-code --name "<short label>" --prompt "<full task prompt for that agent>"
   \`\`\`
   - Each \`vmux new\` returns immediately after spawning the pane — run them sequentially in your Bash tool, one per call.
   - The \`--prompt\` should be a self-contained Claude Code prompt (the spawned agent has no memory of this conversation).
   - Quote properly. Multi-line prompts: use \`$'line 1\\nline 2'\` syntax in bash, or pass a single long sentence.

6. **Report back** with the list of spawned agents and a brief note on how the user can monitor progress (vMux sidebar shows live attention badges per pane).

## Hard rules

- **Never spawn without explicit user confirmation.** Always show the plan first.
- **Never decompose into more than 6 agents** without asking. More than 6 panes becomes hard to monitor.
- **If the task is trivially atomic** (one file edit, one quick fix), say so and refuse to orchestrate — recommend doing it directly instead.
- **If you can't find independent units**, tell the user the task is sequential and stop.

## Tone

Concise. Match the tone of regular Claude Code. No emojis unless the user uses them.

---

**Task:** $ARGUMENTS
`;

interface InstallResult {
  installed: boolean;
  path: string;
  reason:
    | 'fresh-install'
    | 'version-bump'
    | 'unchanged'
    | 'user-edited'
    | 'disabled'
    | 'error'
    | 'unsafe-path';
}

/** Cache du résultat d'install pour la durée du process. installClaudeOrchestrateCommand
 *  peut être appelé depuis plusieurs codepaths (boot + IPC settings update) ; on
 *  ne veut pas refaire mkdir/stat/read/write à chaque appel. */
let cachedResult: InstallResult | null = null;
let inFlight: Promise<InstallResult> | null = null;

/** Reset le cache — exposé pour les tests et pour forcer une réinstall depuis
 *  les settings (ex. user a coché claudeCommandsEnabled puis décoché puis recoché). */
export function resetClaudeCommandsCache(): void {
  cachedResult = null;
  inFlight = null;
}

/** Vérifie qu'un chemin résolu est bien contenu dans un répertoire parent.
 *  Utilisé pour rejeter les symlinks qui pointeraient hors de ~/.claude/commands/. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/** lstat-then-realpath : si la cible est un symlink, on résout le vrai chemin
 *  et on vérifie qu'il pointe toujours sous `root`. Retourne null si la cible
 *  n'existe pas (cas frais install — c'est OK), ou throw si le symlink échappe. */
async function ensureSafeTarget(filePath: string, root: string): Promise<'exists' | 'absent'> {
  try {
    const lst = await fsp.lstat(filePath);
    if (lst.isSymbolicLink()) {
      // Résout la chaîne complète de symlinks et vérifie le résultat.
      const real = await fsp.realpath(filePath);
      if (!isInside(root, real)) {
        throw new Error(`unsafe symlink: ${filePath} → ${real} escapes ${root}`);
      }
    } else if (!lst.isFile()) {
      // Régulier ou rien — un dossier ou un device file à cette place est suspect.
      throw new Error(`unsafe target: ${filePath} is not a regular file`);
    }
    return 'exists';
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
}

/** Écriture atomique : tmp dans le même répertoire + rename. Le tmp porte un
 *  nonce pour éviter une collision si deux vMux concurrents s'installent en
 *  même temps. */
async function atomicWrite(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  const nonce = randomBytes(8).toString('hex');
  const tmp = path.join(dir, `.orchestrate.${process.pid}.${nonce}.tmp`);
  let handle: import('node:fs').promises.FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    try { await handle.sync(); } catch { /* fsync optional */ }
    await handle.close();
    handle = null;
    await fsp.rename(tmp, target);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

async function installImpl(): Promise<InstallResult> {
  const home = app.getPath('home');
  // commandsRoot = la racine "safe" hors de laquelle aucun chemin résolu ne
  // doit sortir (defense contre symlink + path traversal).
  const commandsRoot = path.join(home, '.claude', 'commands');
  const dir = path.join(commandsRoot, 'vmux');
  const file = path.join(dir, 'orchestrate.md');

  // Sanity check : `home` doit être un chemin absolu non-vide. Sur certains
  // setups corrompus (CI sans HOME), Electron renvoie '.' ce qui ferait écrire
  // dans le cwd du process.
  if (!home || !path.isAbsolute(home)) {
    log.warn(`[claude-commands] home path invalid: ${home}`);
    return { installed: false, path: file, reason: 'unsafe-path' };
  }
  if (!isInside(commandsRoot, dir) || !isInside(commandsRoot, file)) {
    // Théoriquement impossible vu qu'on path.join — mais defense in depth.
    log.warn('[claude-commands] computed path escapes commands root');
    return { installed: false, path: file, reason: 'unsafe-path' };
  }

  try {
    await fsp.mkdir(dir, { recursive: true });

    // Vérifier que `dir` lui-même n'est pas un symlink échappant.
    try {
      const dirLst = await fsp.lstat(dir);
      if (dirLst.isSymbolicLink()) {
        const realDir = await fsp.realpath(dir);
        if (!isInside(commandsRoot, realDir)) {
          log.warn(`[claude-commands] vmux/ dir is symlink escaping commands root: ${realDir}`);
          return { installed: false, path: file, reason: 'unsafe-path' };
        }
      }
    } catch (err) {
      log.warn('[claude-commands] dir lstat failed', err);
      return { installed: false, path: file, reason: 'error' };
    }

    // Vérifier que `file` (s'il existe) est un fichier régulier ou un symlink
    // qui ne sort pas de commandsRoot.
    let existence: 'exists' | 'absent';
    try {
      existence = await ensureSafeTarget(file, commandsRoot);
    } catch (err) {
      log.warn('[claude-commands] target safety check failed', err);
      return { installed: false, path: file, reason: 'unsafe-path' };
    }

    let existing: string | null = null;
    if (existence === 'exists') {
      try {
        const st = await fsp.stat(file);
        if (st.size > MAX_EXISTING_BYTES) {
          log.warn(`[claude-commands] existing file too large (${st.size}), leaving untouched`);
          return { installed: false, path: file, reason: 'user-edited' };
        }
        existing = await fsp.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('[claude-commands] read existing failed', err);
          return { installed: false, path: file, reason: 'error' };
        }
      }
    }

    if (existing === null) {
      await atomicWrite(file, SLASH_COMMAND_BODY);
      log.info(`[claude-commands] installed /vmux:orchestrate at ${file}`);
      return { installed: true, path: file, reason: 'fresh-install' };
    }

    const match = existing.match(VERSION_RE);
    if (!match) {
      log.info(
        `[claude-commands] ${file} exists without vmux marker — leaving user version untouched`
      );
      return { installed: false, path: file, reason: 'user-edited' };
    }

    const existingVersion = parseInt(match[1], 10);
    if (!Number.isFinite(existingVersion)) {
      log.info('[claude-commands] existing marker has non-numeric version, leaving untouched');
      return { installed: false, path: file, reason: 'user-edited' };
    }
    if (existingVersion >= COMMAND_VERSION) {
      return { installed: false, path: file, reason: 'unchanged' };
    }

    await atomicWrite(file, SLASH_COMMAND_BODY);
    log.info(
      `[claude-commands] upgraded /vmux:orchestrate (v${existingVersion} → v${COMMAND_VERSION})`
    );
    return { installed: true, path: file, reason: 'version-bump' };
  } catch (err) {
    log.warn('[claude-commands] install failed', err);
    return { installed: false, path: file, reason: 'error' };
  }
}

/**
 * Installe (ou met à jour) le slash-command `/vmux:orchestrate` dans
 * `~/.claude/commands/vmux/orchestrate.md`.
 *
 * Idempotent :
 * - Fichier absent → écrit (atomique : tmp + rename)
 * - Marker présent avec version < COMMAND_VERSION → overwrite
 * - Marker présent avec version ≥ COMMAND_VERSION → no-op
 * - Marker ABSENT (user a édité ou créé son propre fichier) → no-op, on respecte
 *
 * Sécurité :
 * - Tous les chemins résolus doivent rester sous `~/.claude/commands/`. Un
 *   symlink échappant la racine est rejeté (jamais écrasé, jamais suivi pour
 *   write).
 * - Taille du fichier existant capée (MAX_EXISTING_BYTES) pour empêcher une
 *   bombe symlink ; au-delà on laisse intact.
 * - Écriture atomique (tmp avec nonce + rename) pour ne jamais laisser un
 *   fichier tronqué visible à Claude Code.
 *
 * Perf : résultat caché pour la durée du process — appels suivants short-circuit.
 * Appels concurrents partagent la même promise en flight.
 */
export async function installClaudeOrchestrateCommand(): Promise<InstallResult> {
  if (cachedResult) return cachedResult;
  if (inFlight) return inFlight;
  inFlight = installImpl().then(
    (r) => {
      cachedResult = r;
      inFlight = null;
      return r;
    },
    (err) => {
      inFlight = null;
      throw err;
    }
  );
  return inFlight;
}
