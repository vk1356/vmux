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

async function git(cwd: string, args: string[]): Promise<string> {
  // AbortSignal.timeout (Node 20+) remplace timeout+killSignal et offre une
  // sémantique uniforme cross-platform (Windows ignore SIGKILL côté node-pty
  // mais execFile l'utilise via taskkill — AbortSignal homogénéise).
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS)
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

export async function inspectRepo(dir: string): Promise<GitRepoInfo> {
  const empty: GitRepoInfo = {
    isRepo: false,
    path: dir,
    branches: [],
    hasUncommitted: false
  };
  if (!(await pathExists(dir))) return empty;
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const branchesRaw = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    const branches = branchesRaw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const status = await git(top, ['status', '--porcelain']);
    return {
      isRepo: true,
      path: top,
      currentBranch: branch === 'HEAD' ? undefined : branch,
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
 * Crée un git worktree pour un nouvel agent.
 * - parentDir par défaut: ../<repo>-worktrees/
 * - si la branche existe déjà: l'attache (pas de -b)
 * - sinon: la crée à partir de `base` (HEAD par défaut)
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeResult> {
  const repo = (await git(opts.repo, ['rev-parse', '--show-toplevel'])).trim();
  const repoName = path.basename(repo);
  const parent = opts.parentDir || path.join(path.dirname(repo), `${repoName}-worktrees`);
  const wtPath = path.join(parent, sanitize(opts.branch));

  if (await pathExists(wtPath)) {
    return { path: wtPath, branch: opts.branch, created: false };
  }

  const existingBranches = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  // Defense en profondeur : refuse les refs/paths qui commencent par "-" pour
  // empêcher qu'un input contrôlé par l'utilisateur soit interprété comme un
  // git option (--upload-pack=evil, --output=…). execFile sans shell évite
  // l'injection shell, mais git interprète tout leading-dash comme un flag.
  // `sanitize()` lave déjà la branch côté path, mais le `base` arrive direct.
  const safeBase = opts.base && !opts.base.startsWith('-') ? opts.base : 'HEAD';
  if (opts.branch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${opts.branch}`);
  }
  if (wtPath.startsWith('-')) {
    throw new Error(`Invalid worktree path: ${wtPath}`);
  }

  const args = ['worktree', 'add'];
  if (existingBranches.includes(opts.branch)) {
    args.push(wtPath, opts.branch);
  } else {
    args.push('-b', opts.branch, wtPath, safeBase);
  }

  await git(repo, args);
  return { path: wtPath, branch: opts.branch, created: true };
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', '--force', wtPath]);
  } catch {
    // Ignorer — le worktree a peut-être déjà été nettoyé.
  }
}

export async function listWorktrees(repo: string): Promise<{ path: string; branch?: string }[]> {
  try {
    const out = await git(repo, ['worktree', 'list', '--porcelain']);
    const blocks = out.split(/\r?\n\r?\n/);
    const result: { path: string; branch?: string }[] = [];
    for (const b of blocks) {
      const lines = b.split(/\r?\n/);
      const wt = lines.find((l) => l.startsWith('worktree '))?.slice(9).trim();
      const br = lines.find((l) => l.startsWith('branch '))?.slice(7).trim();
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
