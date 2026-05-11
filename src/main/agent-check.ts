import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log/main';
import type { AgentAvailability, AgentPreset } from '@shared/types';

const execFileAsync = promisify(execFile);

interface CacheEntry {
  found: boolean;
  resolvedPath?: string;
  expiry: number;
}

/** Cache keyé par `command` (ce que l'user tape : `claude`, `cursor-agent`…). */
const cache = new Map<string, CacheEntry>();
/** Cache keyé par absolute path (validation rapide d'un chemin déjà résolu —
 *  ex: settings stocke un path absolu et on veut éviter de relancer `where`). */
const pathCache = new Map<string, CacheEntry>();
const TTL = 30_000;
const PROBE_TIMEOUT_MS = 3_000;

/** In-flight dedup : si deux callers demandent simultanément le même binaire
 *  pendant la première résolution, on ne lance pas 2 process — on partage la
 *  même promesse. Évite un thundering herd au boot quand `/checkAgents` est
 *  appelé en parallèle avec la liste des sessions persistées. */
const inflight = new Map<string, Promise<{ found: boolean; resolvedPath?: string }>>();

/**
 * Vérifie qu'un binaire CLI est dans le PATH.
 * - Windows : `where.exe <cmd>` (gère .cmd / .exe / .ps1 via PATHEXT).
 * - POSIX   : `which <cmd>`.
 *
 * Mis en cache 30s pour éviter de relancer des process pour chaque ouverture
 * du dialog "Nouvelle session". Supporte un `AbortSignal` externe (ex: dialog
 * fermé avant la résolution) qui sera composé avec le timeout interne.
 */
export async function isAgentAvailable(
  command: string,
  signal?: AbortSignal
): Promise<{ found: boolean; resolvedPath?: string }> {
  const now = Date.now();
  const cached = cache.get(command);
  if (cached && cached.expiry > now) {
    return { found: cached.found, resolvedPath: cached.resolvedPath };
  }

  const existing = inflight.get(command);
  if (existing) return existing;

  const promise = runProbe(command, signal).finally(() => inflight.delete(command));
  inflight.set(command, promise);
  return promise;
}

async function runProbe(
  command: string,
  signal?: AbortSignal
): Promise<{ found: boolean; resolvedPath?: string }> {
  const tool = process.platform === 'win32' ? 'where.exe' : 'which';
  const now = Date.now();

  // Compose le timeout interne avec le signal external (caller annulable).
  // AbortSignal.any disponible en Node 20.3+, qui matche notre target Electron 42.
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const composedSignal: AbortSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;

  try {
    const { stdout } = await execFileAsync(tool, [command], {
      windowsHide: true,
      signal: composedSignal
    });
    const resolvedPath = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    const result = { found: !!resolvedPath, resolvedPath };
    cache.set(command, { ...result, expiry: now + TTL });
    if (resolvedPath) pathCache.set(resolvedPath, { ...result, expiry: now + TTL });
    return result;
  } catch (err) {
    // AbortError externe : ne pas pollue le cache négativement (le caller a
    // juste fermé son dialog, le binaire existe peut-être).
    const aborted = signal?.aborted === true;
    if (!aborted) {
      cache.set(command, { found: false, expiry: now + TTL });
      log.debug('[agent-check] probe failed', { command, err: (err as Error)?.message });
    }
    return { found: false };
  }
}

/** Variante par chemin absolu : utile quand settings stocke un path résolu et
 *  qu'on veut juste valider qu'il existe encore (TTL court). Ne lance pas de
 *  child process — c'est juste un fs.access. */
export async function isAgentPathAvailable(absolutePath: string): Promise<boolean> {
  const now = Date.now();
  const cached = pathCache.get(absolutePath);
  if (cached && cached.expiry > now) return cached.found;
  try {
    const { access } = await import('node:fs/promises');
    await access(absolutePath);
    pathCache.set(absolutePath, { found: true, resolvedPath: absolutePath, expiry: now + TTL });
    return true;
  } catch {
    pathCache.set(absolutePath, { found: false, expiry: now + TTL });
    return false;
  }
}

/**
 * Probe en parallèle tous les agents. `allSettled` plutôt que `Promise.all` :
 * un seul agent qui throw (rarissime mais possible avec AbortSignal.any) ne
 * doit pas masquer la disponibilité des autres.
 */
export async function checkAgents(
  agents: AgentPreset[],
  signal?: AbortSignal
): Promise<AgentAvailability[]> {
  const results = await Promise.allSettled(
    agents.map(async (a) => {
      // Le shell brut "pwsh" est traité spécialement — toujours trouvé via fallback.
      if (a.id === 'shell') return { id: a.id, found: true } as AgentAvailability;
      const r = await isAgentAvailable(a.command, signal);
      return { id: a.id, found: r.found, resolvedPath: r.resolvedPath } as AgentAvailability;
    })
  );
  return results.map((res, i) => {
    if (res.status === 'fulfilled') return res.value;
    log.debug('[agent-check] entry rejected', { id: agents[i].id, err: res.reason });
    return { id: agents[i].id, found: false };
  });
}

export function invalidateAgentCache(): void {
  cache.clear();
  pathCache.clear();
  inflight.clear();
}
