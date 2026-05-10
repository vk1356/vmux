import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitRepoInfo } from '@shared/types';

const execFileAsync = promisify(execFile);

/** Timeout par défaut sur les appels `git` — un repo corrompu, un mount réseau
 *  lent, ou un hook git qui freeze peut bloquer le main process indéfiniment.
 *  30s couvre largement les `worktree add` les plus lents (clone shallow, etc.). */
const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  });
  return stdout;
}

export async function inspectRepo(dir: string): Promise<GitRepoInfo> {
  const empty: GitRepoInfo = {
    isRepo: false,
    path: dir,
    branches: [],
    hasUncommitted: false
  };
  if (!existsSync(dir)) return empty;
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

  if (existsSync(wtPath)) {
    return { path: wtPath, branch: opts.branch, created: false };
  }

  const existingBranches = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const args = ['worktree', 'add'];
  if (existingBranches.includes(opts.branch)) {
    args.push(wtPath, opts.branch);
  } else {
    args.push('-b', opts.branch, wtPath, opts.base || 'HEAD');
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
