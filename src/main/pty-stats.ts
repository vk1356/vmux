import { EventEmitter } from 'node:events';
import pidusage from 'pidusage';
import pidtree from 'pidtree';
import log from 'electron-log/main';
import type { PaneId } from '@shared/types';

/** Sample envoyé au renderer pour un pane à un instant donné. */
export interface PaneStatSample {
  paneId: PaneId;
  /** CPU% — 0..100*vcore (sur 8 coeurs : peut monter à ~800). */
  cpu: number;
  /** RAM en octets. */
  memory: number;
  timestamp: number;
}

type Events = {
  stats: [samples: PaneStatSample[]];
};

/**
 * Collecte CPU/RAM pour les PIDs des PTY actifs et émet périodiquement
 * un batch de samples au renderer. Coût mesuré : ~3-5 ms par poll sur
 * Windows (wmic), même pour 10+ panes.
 */
class PtyStatsCollector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  /** paneId → pid courant. Réécrit à chaque restart. */
  private pids = new Map<PaneId, number>();
  /** Intervalle de poll : 2s — assez réactif pour voir les pics, assez lent
   *  pour que `wmic` n'impacte pas les perfs sur Windows. */
  private static readonly POLL_INTERVAL_MS = 2000;

  setPid(paneId: PaneId, pid: number): void {
    this.pids.set(paneId, pid);
    this.ensureRunning();
  }

  removePane(paneId: PaneId): void {
    this.pids.delete(paneId);
    if (this.pids.size === 0) this.stop();
  }

  /** Pas de panes vivants → arrête le timer. Évite des polls vides. */
  private ensureRunning(): void {
    if (this.timer || this.pids.size === 0) return;
    this.timer = setInterval(() => void this.collect(), PtyStatsCollector.POLL_INTERVAL_MS);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Pour un PID donné, retourne pid + tous ses descendants. Sur Windows, c'est
   *  crucial : `pty.pid` pointe sur `pwsh.exe` (le wrapper) mais l'agent
   *  (`claude`/`codex`/`node.exe` enfant) tourne dans un sous-processus.
   *  Sans cette agrégation, les stats restent figées sur le shell idle. */
  private async treePids(rootPid: number): Promise<number[]> {
    try {
      const children = await pidtree(rootPid);
      // pidtree renvoie uniquement les descendants — on ajoute la racine.
      return [rootPid, ...children];
    } catch {
      // Le process est mort ou inaccessible : on retombe sur le pid seul,
      // pidusage gérera le throw downstream.
      return [rootPid];
    }
  }

  private async collect(): Promise<void> {
    const entries = Array.from(this.pids.entries());
    if (entries.length === 0) return;
    const ts = Date.now();

    // Étape 1 : pour chaque pane, énumère pid + descendants.
    const trees = await Promise.all(
      entries.map(async ([paneId, pid]) => ({
        paneId,
        rootPid: pid,
        pids: await this.treePids(pid)
      }))
    );

    // Étape 2 : flatten et dedupe pour un seul appel pidusage batché.
    const allPids = Array.from(new Set(trees.flatMap((t) => t.pids)));
    let stats: Record<number, { cpu: number; memory: number }> = {};
    try {
      stats = await pidusage(allPids);
    } catch {
      // Au moins un PID mort dans le batch : retombe sur du per-pid pour ne
      // pas perdre les autres.
      await Promise.all(
        allPids.map(async (pid) => {
          try {
            const s = await pidusage(pid);
            stats[pid] = { cpu: s.cpu, memory: s.memory };
          } catch {
            /* pid mort — on saute */
          }
        })
      );
    }

    // Étape 3 : somme par pane.
    const samples: PaneStatSample[] = [];
    for (const tree of trees) {
      let cpuSum = 0;
      let memSum = 0;
      let alive = false;
      for (const pid of tree.pids) {
        const s = stats[pid];
        if (s) {
          cpuSum += s.cpu;
          memSum += s.memory;
          alive = true;
        }
      }
      if (alive) {
        samples.push({ paneId: tree.paneId, cpu: cpuSum, memory: memSum, timestamp: ts });
      } else {
        // Tous les PIDs morts (pwsh + descendants) → le pane n'a plus de
        // process actif, on l'enlève de la map pour libérer le timer.
        this.pids.delete(tree.paneId);
        log.debug(`[stats] pane ${tree.paneId} (root pid=${tree.rootPid}) has no live process`);
      }
    }
    if (samples.length > 0) this.emit('stats', samples);
  }

  shutdown(): void {
    this.stop();
    this.pids.clear();
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }
}

export const ptyStats = new PtyStatsCollector();
