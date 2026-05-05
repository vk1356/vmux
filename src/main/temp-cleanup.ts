import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log/main';

const PASTE_PATTERN = /^vmux-paste-\d+\.png$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Nettoie les fichiers temporaires `vmux-paste-*.png` plus vieux que 24h.
 * Appelé au boot pour éviter d'accumuler indéfiniment.
 */
export async function cleanupPasteTempFiles(): Promise<void> {
  const dir = os.tmpdir();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!PASTE_PATTERN.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (now - st.mtimeMs > MAX_AGE_MS) {
        await fsp.unlink(full);
        removed++;
      }
    } catch {
      /* skip — fichier disparu ou non accessible */
    }
  }
  if (removed > 0) log.info(`[cleanup] removed ${removed} stale paste files`);
}
