import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log/main';

// Paste images: `vmux-paste-<timestamp>.png`.
const PASTE_FILE_PATTERN = /^vmux-paste-\d+\.png$/;
// Worktrees / scratch dirs créés par vMux et abandonnés sur crash.
// Format historique : `vmux-worktree-<sessionId>` ou `vmux-tmp-<timestamp>`.
const PASTE_DIR_PATTERN = /^vmux-(?:worktree|tmp)-/;

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PARALLEL = 16;

let running = false;

/** Limite la concurrence d'un batch async — évite d'ouvrir 10000 handles fs
 *  sur un /tmp pollué. */
async function parallelMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Nettoie les artefacts temporaires de vMux plus vieux que 24h :
 *   - fichiers `vmux-paste-*.png`
 *   - dossiers `vmux-worktree-*` / `vmux-tmp-*` (orphelins de crash)
 *
 * Appelé au boot. Garde anti-réentrance : si déjà en cours, no-op.
 * Toute erreur fs sur une entrée est swallowée — on continue le sweep.
 */
export async function cleanupPasteTempFiles(): Promise<void> {
  if (running) {
    log.debug('[cleanup] already running — skipping');
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const dir = os.tmpdir();
    let entries: import('node:fs').Dirent[];
    try {
      // withFileTypes : on évite un stat par entrée pour distinguer fichier/dossier.
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn('[cleanup] cannot readdir tmpdir', err);
      return;
    }

    const targets = entries.filter((e) => {
      const isFile = e.isFile();
      const isDir = e.isDirectory();
      if (isFile && PASTE_FILE_PATTERN.test(e.name)) return true;
      if (isDir && PASTE_DIR_PATTERN.test(e.name)) return true;
      return false;
    });

    if (targets.length === 0) return;

    const now = Date.now();
    let removedFiles = 0;
    let removedDirs = 0;
    const results = await parallelMap(targets, MAX_PARALLEL, async (ent) => {
      const full = path.join(dir, ent.name);
      let st: import('node:fs').Stats;
      try {
        st = await fsp.stat(full);
      } catch {
        return null; // disparu entre readdir et stat — ok
      }
      if (now - st.mtimeMs <= MAX_AGE_MS) return null;
      if (ent.isFile()) {
        try {
          await fsp.unlink(full);
          removedFiles++;
        } catch (err) {
          log.debug(`[cleanup] unlink failed for ${ent.name}`, err);
        }
      } else if (ent.isDirectory()) {
        try {
          // recursive + force : ne throw pas sur ENOENT, supprime contenu.
          // maxRetries protège contre les EBUSY Windows quand un handle traîne.
          await fsp.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          removedDirs++;
        } catch (err) {
          log.debug(`[cleanup] rm failed for ${ent.name}`, err);
        }
      }
      return null;
    });

    // results est utilisé pour s'assurer que les rejets sont awaited — sinon
    // unhandledRejection. parallelMap n'en produit pas (try/catch interne).
    void results;

    if (removedFiles > 0 || removedDirs > 0) {
      const elapsed = Date.now() - started;
      log.info(
        `[cleanup] removed ${removedFiles} stale paste file(s), ${removedDirs} dir(s) in ${elapsed}ms`
      );
    }
  } finally {
    running = false;
  }
}
