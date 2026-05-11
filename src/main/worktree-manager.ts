import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitRepoInfo } from '@shared/types';

const execFileAsync = promisify(execFile);

/** Timeout par défaut sur les appels `git` — un repo corrompu, un mount réseau
 *  lent, ou un hook git qui freeze peut bloquer le main process indéfiniment.
 *  30s couvre largement les `worktree add` les plus lents (clone shallow, etc.). */
const GIT_TIMEOUT_MS = 30_000;

/** Cap stdout buffer pour les commandes git. 10 MiB couvre `for-each-ref` sur
 *  des monorepos avec ~50k branches et `status --porcelain` sur des working
 *  trees énormes. Au-delà on tue le process plutôt que d'OOM le main. */
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Exécute `git` via execFile (jamais shell:true sur Windows — CVE-2024-27980).
 *
 * Sécurité :
 * - `args` est passé en array → aucune interpolation shell possible.
 * - Node 20+ avec shell:false (défaut) corrige le bug de lookup .cmd Windows.
 * - `windowsHide` masque la console flash sur Windows.
 * - AbortSignal.timeout évite les git zombies sur réseau lent.
 */
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(GIT_TIMEOUT_MS);
  // Combine le signal externe (annulation user) avec le timeout interne.
  const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    signal: composed
  });
  return stdout;
}

/** Test d'existence non-bloquant. fs.existsSync() faisait du sync I/O sur le
 *  main thread Electron — sur un mount réseau lent ça stallait toute l'UI. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cache `git rev-parse --show-toplevel` par chemin avec TTL 30s.
 * Spawner 8 agents sur le même repo lançait 8 `git rev-parse` séquentiels (~80ms
 * cumulés sur Windows). Le top-level ne change pas tant que l'user ne déplace
 * pas le repo — TTL court pour rester honnête sur les éditions externes.
 */
const TOPLEVEL_TTL_MS = 30_000;
const toplevelCache = new Map<string, { value: string; expiresAt: number }>();

async function resolveToplevel(dir: string): Promise<string> {
  const now = Date.now();
  const hit = toplevelCache.get(dir);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  toplevelCache.set(dir, { value, expiresAt: now + TOPLEVEL_TTL_MS });
  return value;
}

// ============================================================
// Validation — frontière dure pour tous les inputs user-controlled
// ============================================================

/**
 * Valide un nom de branche git selon `git check-ref-format` (subset strict).
 * Rejette :
 * - leading-dash (interprété comme flag par git : `--upload-pack=evil`)
 * - NUL byte, control chars (smuggling via newline)
 * - séquences interdites par refs git : `..`, `@{`, `\`, `:`, `?`, `*`, `[`, `^`, `~`, ` `
 * - trailing `.lock` (file convention git)
 * - longueur > 250 (sanity cap, git autorise plus mais Windows MAX_PATH s'en mêle)
 */
function isValidBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 250) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.lock') || name.endsWith('.')) return false;
  // Caractères interdits : NUL + control chars + métacaractères git refs.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f \\:?*[\]^~]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  return true;
}

/**
 * Valide un commit-ish (base) pour `worktree add -b <branch> <path> <base>`.
 * Plus permissif qu'un branch name (autorise refs/tags/SHA/`origin/main`) mais
 * bloque toute syntaxe interprétable comme flag git.
 */
function isValidCommitish(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 250) return false;
  if (ref.startsWith('-')) return false; // bloque `--upload-pack=…`, `-c`, etc.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\: \t]/.test(ref)) return false;
  return true;
}

/**
 * Vérifie que `child` est strictement contenu dans `parent` après résolution.
 * Empêche traversal via `..` injecté dans `parentDir` ou `branch`.
 */
function isPathContained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (!rel) return false; // identique au parent
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export async function inspectRepo(dir: string): Promise<GitRepoInfo> {
  const empty: GitRepoInfo = {
    isRepo: false,
    path: dir,
    branches: [],
    hasUncommitted: false
  };
  if (!(await pathExists(dir))) return empty;
  try {
    const top = await resolveToplevel(dir);
    // Les 3 appels restants sont indépendants une fois `top` connu — parallel.
    // Sur un repo "tiède" Windows ça passe de ~140ms à ~55ms.
    const [branch, branchesRaw, status] = await Promise.all([
      git(top, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      git(top, ['status', '--porcelain'])
    ]);
    const branches = branchesRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const currentBranch = branch.trim();
    return {
      isRepo: true,
      path: top,
      currentBranch: currentBranch === 'HEAD' ? undefined : currentBranch,
      branches,
      hasUncommitted: status.trim().length > 0
    };
  } catch {
    return empty;
  }
}

export interface CreateWorktreeOptions {
  repo: string;
  branch: string;
  base?: string;
  parentDir?: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Mutex par-repo : sérialise les opérations worktree concurrentes sur un même
 * repo. Sans ça, deux `createSession` simultanés sur la même branche peuvent :
 *   t0: A: pathExists(wt) → false
 *   t1: B: pathExists(wt) → false
 *   t2: A: worktree add (succès)
 *   t3: B: worktree add (échec "already checked out")
 * Le lock garantit la sérialisation logique sans bloquer les autres repos.
 */
const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  repoLocks.set(
    repo,
    next.catch(() => undefined)
  );
  try {
    return await next;
  } finally {
    // Libère la slot si on est encore le dernier maillon (sinon la chaîne suivante
    // a déjà pris la place — pas la peine de la perdre).
    if (repoLocks.get(repo) === next.catch(() => undefined)) {
      repoLocks.delete(repo);
    }
  }
}

/**
 * Crée un git worktree pour un nouvel agent.
 * - parentDir par défaut: ../<repo>-worktrees/
 * - si la branche existe déjà: l'attache (pas de -b)
 * - sinon: la crée à partir de `base` (HEAD par défaut)
 *
 * Sérialisé per-repo via mutex pour éviter les races sur worktree add concurrent.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeResult> {
  // Validation stricte AVANT toute opération git (defense en profondeur).
  if (!isValidBranchName(opts.branch)) {
    throw new Error(`Invalid branch name: ${String(opts.branch).slice(0, 64)}`);
  }
  if (opts.base !== undefined && !isValidCommitish(opts.base)) {
    throw new Error(`Invalid base ref: ${String(opts.base).slice(0, 64)}`);
  }
  if (opts.parentDir !== undefined) {
    if (typeof opts.parentDir !== 'string' || opts.parentDir.length === 0) {
      throw new Error('Invalid parentDir');
    }
    if (opts.parentDir.includes('\0')) throw new Error('Invalid parentDir');
  }

  const repo = await resolveToplevel(opts.repo);
  return withRepoLock(repo, async () => {
    const repoName = path.basename(repo);
    const parent = path.resolve(
      opts.parentDir ?? path.join(path.dirname(repo), `${repoName}-worktrees`)
    );
    const wtPath = path.resolve(path.join(parent, sanitize(opts.branch)));

    // Containment : wtPath doit être strictement à l'intérieur de parent — bloque
    // toute tentative de traversal via `branch="../../etc"` (sanitize en attrape
    // déjà la majorité, mais double-check).
    if (!isPathContained(parent, wtPath)) {
      throw new Error('Worktree path escapes parent directory');
    }
    if (wtPath.startsWith('-')) {
      throw new Error(`Invalid worktree path: ${wtPath}`);
    }

    if (await pathExists(wtPath)) {
      return { path: wtPath, branch: opts.branch, created: false };
    }

    const existingBranches = (
      await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    )
      .split(/\r?\n/)
      .map((b) => b.trim())
      .filter(Boolean);

    const safeBase = opts.base ?? 'HEAD';

    // `--` sentinel : git interprète tout token après comme positional, jamais
    // comme flag. Ceinture + bretelles sur l'isValidBranchName/isValidCommitish.
    const args = ['worktree', 'add'];
    if (existingBranches.includes(opts.branch)) {
      args.push('--', wtPath, opts.branch);
    } else {
      args.push('-b', opts.branch, '--', wtPath, safeBase);
    }

    try {
      await git(repo, args);
    } catch (err) {
      // Best-effort cleanup si le dossier a été partiellement créé puis git a
      // failed (hook reject, disk full au milieu, etc.). Sans ça le prochain
      // createWorktree verra pathExists=true et retournera created:false sur
      // une ref fantôme.
      await fsp.rm(wtPath, { recursive: true, force: true }).catch(() => undefined);
      // Prune les fichiers admin orphelins côté .git/worktrees/.
      await git(repo, ['worktree', 'prune']).catch(() => undefined);
      throw err;
    }
    return { path: wtPath, branch: opts.branch, created: true };
  });
}

/**
 * Supprime un worktree et nettoie les artefacts résiduels.
 * Idempotent : safe à appeler sur un worktree déjà supprimé manuellement.
 * Sérialisé per-repo (même mutex que createWorktree) pour éviter une race
 * où un add et un remove concurrents corrompraient `.git/worktrees/`.
 */
export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  let top: string;
  try {
    top = await resolveToplevel(repo);
  } catch {
    top = repo;
  }
  await withRepoLock(top, async () => {
    try {
      await git(top, ['worktree', 'remove', '--force', '--', wtPath]);
    } catch {
      // remove a échoué — typiquement parce que le dossier a été supprimé
      // manuellement. On force le rm puis on prune les admin files.
    }
    // Cleanup physique du dossier (au cas où git remove l'aurait laissé) +
    // prune des refs `.git/worktrees/<name>` orphelines. Toujours best-effort.
    await fsp.rm(wtPath, { recursive: true, force: true }).catch(() => undefined);
    await git(top, ['worktree', 'prune']).catch(() => undefined);
  });
}

/**
 * Liste les worktrees via parsing du format porcelain `-z` (null-terminated).
 * Le format `--porcelain -z` sépare les entries par NUL et chaque attribut par
 * NUL également — robust contre les paths contenant des newlines (légal sur
 * Linux/macOS, peut arriver en pratique sur des paths exotiques).
 *
 * Format observé : `worktree <path>\0HEAD <sha>\0branch <ref>\0\0worktree …`
 * (séparateur entre entries = NUL NUL, séparateur intra = NUL simple)
 */
export async function listWorktrees(repo: string): Promise<{ path: string; branch?: string }[]> {
  try {
    const out = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
    if (!out) return [];
    const result: { path: string; branch?: string }[] = [];
    // Entries séparées par `\0\0`. Sur la dernière entry git n'ajoute pas le
    // double-NUL final → split + filter Boolean couvre les deux cas.
    for (const block of out.split('\0\0').filter(Boolean)) {
      const fields = block.split('\0');
      let wt: string | undefined;
      let br: string | undefined;
      for (const f of fields) {
        if (f.startsWith('worktree ')) wt = f.slice(9);
        else if (f.startsWith('branch ')) br = f.slice(7);
      }
      if (wt) result.push({ path: wt, branch: br?.replace('refs/heads/', '') });
    }
    return result;
  } catch {
    return [];
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
