import { app } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Version logique du contenu du slash-command. Bump quand on change le prompt
 * pour que les installs précédentes soient écrasées (uniquement si elles n'ont
 * pas été éditées à la main par l'user — détecté via le marker en tête de fichier).
 */
const COMMAND_VERSION = 1;
const COMMAND_MARKER = `<!-- vmux-orchestrate version=${COMMAND_VERSION} — DO NOT REMOVE this marker; if you edit this file vMux will stop overwriting it on update -->`;
const VERSION_RE = /<!-- vmux-orchestrate version=(\d+)/;

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
  reason: 'fresh-install' | 'version-bump' | 'unchanged' | 'user-edited' | 'disabled' | 'error';
}

/**
 * Installe (ou met à jour) le slash-command `/vmux:orchestrate` dans
 * `~/.claude/commands/vmux/orchestrate.md`.
 *
 * Idempotent :
 * - Fichier absent → écrit
 * - Marker présent avec version < COMMAND_VERSION → overwrite
 * - Marker présent avec version ≥ COMMAND_VERSION → no-op
 * - Marker ABSENT (user a édité ou créé son propre fichier) → no-op, on respecte
 */
export async function installClaudeOrchestrateCommand(): Promise<InstallResult> {
  const home = app.getPath('home');
  const dir = path.join(home, '.claude', 'commands', 'vmux');
  const file = path.join(dir, 'orchestrate.md');
  try {
    await fsp.mkdir(dir, { recursive: true });
    let existing: string | null = null;
    try {
      existing = await fsp.readFile(file, 'utf8');
    } catch (err) {
      // ENOENT = pas de fichier, on installe frais. Toute autre erreur = on log et abort.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('[claude-commands] read existing failed', err);
        return { installed: false, path: file, reason: 'error' };
      }
    }

    if (existing === null) {
      await fsp.writeFile(file, SLASH_COMMAND_BODY, 'utf8');
      log.info(`[claude-commands] installed /vmux:orchestrate at ${file}`);
      return { installed: true, path: file, reason: 'fresh-install' };
    }

    const match = existing.match(VERSION_RE);
    if (!match) {
      // Pas de marker → l'utilisateur l'a édité (ou écrit son propre command).
      // On respecte sa version et on log juste pour qu'il sache qu'on existe.
      log.info(
        `[claude-commands] ${file} exists without vmux marker — leaving user version untouched`
      );
      return { installed: false, path: file, reason: 'user-edited' };
    }

    const existingVersion = parseInt(match[1], 10);
    if (existingVersion >= COMMAND_VERSION) {
      return { installed: false, path: file, reason: 'unchanged' };
    }

    await fsp.writeFile(file, SLASH_COMMAND_BODY, 'utf8');
    log.info(
      `[claude-commands] upgraded /vmux:orchestrate (v${existingVersion} → v${COMMAND_VERSION})`
    );
    return { installed: true, path: file, reason: 'version-bump' };
  } catch (err) {
    log.warn('[claude-commands] install failed', err);
    return { installed: false, path: file, reason: 'error' };
  }
}
