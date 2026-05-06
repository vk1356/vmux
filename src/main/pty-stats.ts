import { EventEmitter } from 'node:events';
import pidusage from 'pidusage';
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

  private async collect(): Promise<void> {
    const entries = Array.from(this.pids.entries());
    if (entries.length === 0) return;
    const pidArr = entries.map(([, pid]) => pid);
    const ts = Date.now();

    try {
      const stats = await pidusage(pidArr);
      const samples: PaneStatSample[] = [];
      for (const [paneId, pid] of entries) {
        const s = stats[pid];
        if (s) samples.push({ paneId, cpu: s.cpu, memory: s.memory, timestamp: ts });
      }
      if (samples.length > 0) this.emit('stats', samples);
    } catch (err) {
      // pidusage throw si UN seul PID est mort — on retombe sur du per-PID
      // pour ne pas perdre les autres samples.
      const samples: PaneStatSample[] = [];
      await Promise.all(
        entries.map(async ([paneId, pid]) => {
          try {
            const s = await pidusage(pid);
            samples.push({ paneId, cpu: s.cpu, memory: s.memory, timestamp: ts });
          } catch {
            // PID mort : on retire silencieusement de la map.
            this.pids.delete(paneId);
          }
        })
      );
      if (samples.length > 0) this.emit('stats', samples);
      log.debug('[stats] batch failed, fell back to per-pid', (err as Error).message);
    }
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
