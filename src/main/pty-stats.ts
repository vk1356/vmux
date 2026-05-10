import { EventEmitter } from 'node:events';
import os from 'node:os';
import pidusage from 'pidusage';
import pidtree from 'pidtree';
import log from 'electron-log/main';
import type { PaneId, SystemStatsSample } from '@shared/types';

/** Sample envoyé au renderer pour un pane à un instant donné. */
export interface PaneStatSample {
  paneId: PaneId;
  /** CPU% — 0..100*vcore (sur 8 coeurs : peut monter à ~800). */
  cpu: number;
  /** RAM en octets. */
  memory: number;
  timestamp: number;
  /** Nombre de cœurs logiques. */
  cores: number;
  /** False sur le 1er sample (pidusage a besoin de 2 ticks pour le delta CPU). */
  primed: boolean;
}

type Events = {
  stats: [samples: PaneStatSample[]];
  systemStats: [sample: SystemStatsSample];
};

/**
 * Collecte CPU/RAM pour les PIDs des PTY actifs et émet périodiquement
 * un batch de samples au renderer. Coût mesuré : ~3-5 ms par poll sur
 * Windows. pidusage v4 utilise GetProcessTimes/PSAPI via N-API natif
 * (plus de wmic — deprecated dans Win11), donc l'overhead est constant
 * même pour 10+ panes.
 */
class PtyStatsCollector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  /** paneId → pid courant. Réécrit à chaque restart. */
  private pids = new Map<PaneId, number>();
  /** Panes pour lesquels on a déjà émis ≥2 samples → pidusage CPU est fiable.
   *  Avant ce seuil, on flag `primed: false` pour que l'UI affiche "calculating…"
   *  plutôt qu'un faux 0%. */
  private polledOnce = new Set<PaneId>();
  /** Nombre de cœurs logiques — capturé une fois au boot. Utilisé pour
   *  normaliser le CPU côté UI sans relire `os.cpus()` à chaque sample. */
  private static readonly CORES = Math.max(1, os.cpus().length);
  /** Snapshot CPU machine pour calcul du delta entre 2 polls. */
  private prevCpuTimes: { idle: number; total: number } | null = null;
  /** Intervalle de poll : 2s — assez réactif pour voir les pics, assez lent
   *  pour ne pas peser sur la boucle main process (chaque poll = 1 tick
   *  microtask + N appels syscall via pidusage). */
  private static readonly POLL_INTERVAL_MS = 2000;

  setPid(paneId: PaneId, pid: number): void {
    this.pids.set(paneId, pid);
    // Restart d'un pane → on reset son flag primed pour rejouer "calculating…".
    this.polledOnce.delete(paneId);
    this.ensureRunning();
  }

  removePane(paneId: PaneId): void {
    this.pids.delete(paneId);
    this.polledOnce.delete(paneId);
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
    this.prevCpuTimes = null;
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

  /** Calcule le CPU% machine depuis le delta des CPU times entre 2 polls.
   *  os.cpus() retourne les compteurs cumulés (idle/user/sys/...), on en
   *  déduit le delta. Premier appel : retourne 0 (pas encore de baseline). */
  private sampleSystemCpu(): number {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      const t = c.times;
      idle += t.idle;
      total += t.idle + t.user + t.sys + t.nice + t.irq;
    }
    if (!this.prevCpuTimes) {
      this.prevCpuTimes = { idle, total };
      return 0;
    }
    const dIdle = idle - this.prevCpuTimes.idle;
    const dTotal = total - this.prevCpuTimes.total;
    this.prevCpuTimes = { idle, total };
    if (dTotal <= 0) return 0;
    const usage = 1 - dIdle / dTotal;
    return Math.max(0, Math.min(100, usage * 100));
  }

  private async collect(): Promise<void> {
    const entries = Array.from(this.pids.entries());
    if (entries.length === 0) return;
    const ts = Date.now();
    const cores = PtyStatsCollector.CORES;

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
    let vmuxCpuSum = 0;
    let vmuxMemSum = 0;
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
        const wasPolled = this.polledOnce.has(tree.paneId);
        this.polledOnce.add(tree.paneId);
        samples.push({
          paneId: tree.paneId,
          cpu: cpuSum,
          memory: memSum,
          timestamp: ts,
          cores,
          primed: wasPolled
        });
        vmuxCpuSum += cpuSum;
        vmuxMemSum += memSum;
      } else {
        // Tous les PIDs morts (pwsh + descendants) → le pane n'a plus de
        // process actif, on l'enlève de la map pour libérer le timer.
        this.pids.delete(tree.paneId);
        this.polledOnce.delete(tree.paneId);
        log.debug(`[stats] pane ${tree.paneId} (root pid=${tree.rootPid}) has no live process`);
      }
    }
    if (samples.length > 0) this.emit('stats', samples);

    // Étape 4 : stats système globales — émis même si aucun pane vivant ne reste,
    // tant que le timer tourne. Permet à la status bar d'afficher la charge totale.
    const systemCpu = this.sampleSystemCpu();
    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    this.emit('systemStats', {
      cpu: systemCpu,
      memoryUsed: memUsed,
      memoryTotal: memTotal,
      // vmuxCpuSum est en CPU% × cores → on normalise en %machine.
      vmuxCpu: Math.max(0, Math.min(100, vmuxCpuSum / cores)),
      vmuxMemory: vmuxMemSum,
      cores,
      timestamp: ts
    });
  }

  shutdown(): void {
    this.stop();
    this.pids.clear();
    this.polledOnce.clear();
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }
}

export const ptyStats = new PtyStatsCollector();
