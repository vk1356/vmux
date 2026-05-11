import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAvailability, AgentPreset } from '@shared/types';

const execFileAsync = promisify(execFile);

const cache = new Map<string, { found: boolean; resolvedPath?: string; expiry: number }>();
const TTL = 30_000;

/**
 * Vérifie qu'un binaire CLI est dans le PATH.
 * - Windows : `where.exe <cmd>` (gère .cmd / .exe / .ps1 via PATHEXT).
 * - POSIX   : `which <cmd>`.
 *
 * Mis en cache 30s pour éviter de relancer des process pour chaque ouverture
 * du dialog "Nouvelle session".
 */
export async function isAgentAvailable(command: string): Promise<{ found: boolean; resolvedPath?: string }> {
  const now = Date.now();
  const cached = cache.get(command);
  if (cached && cached.expiry > now) {
    return { found: cached.found, resolvedPath: cached.resolvedPath };
  }

  const tool = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    // AbortSignal.timeout (Node 20+) — un where.exe sur mount réseau lent ne
    // bloque plus le main thread plus de 3s.
    const { stdout } = await execFileAsync(tool, [command], {
      windowsHide: true,
      signal: AbortSignal.timeout(3000)
    });
    const resolvedPath = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    const result = { found: !!resolvedPath, resolvedPath };
    cache.set(command, { ...result, expiry: now + TTL });
    return result;
  } catch {
    const result = { found: false };
    cache.set(command, { ...result, expiry: now + TTL });
    return result;
  }
}

export async function checkAgents(agents: AgentPreset[]): Promise<AgentAvailability[]> {
  return Promise.all(
    agents.map(async (a) => {
      // Le shell brut "pwsh" est traité spécialement — toujours trouvé via fallback.
      if (a.id === 'shell') return { id: a.id, found: true };
      const r = await isAgentAvailable(a.command);
      return { id: a.id, found: r.found, resolvedPath: r.resolvedPath };
    })
  );
}

export function invalidateAgentCache(): void {
  cache.clear();
}
