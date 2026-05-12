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
  /** Cache des arbres de processus par root pid. pidtree fait un spawn de
   *  wmic/Get-CimInstance sur Windows : cher (~30-50ms). On le recalcule
   *  toutes les `TREE_TTL_MS` ou quand un pid disparaît. */
  private treeCache = new Map<number, { pids: number[]; ts: number }>();
  /** Re-entrancy guard : un poll lent pourrait chevaucher le suivant
   *  (pidtree + pidusage = parfois >2s sur machine chargée). */
  private collecting = false;
  /** Shutdown guard : annule les emits en vol après teardown. */
  private aborted = false;
  /** Nombre de cœurs logiques — capturé une fois au boot. Utilisé pour
   *  normaliser le CPU côté UI sans relire `os.cpus()` à chaque sample. */
  private static readonly CORES = Math.max(1, os.cpus().length);
  /** Snapshot CPU machine pour calcul du delta entre 2 polls. */
  private prevCpuTimes: { idle: number; total: number } | null = null;
  /** Intervalle de poll : 2s — assez réactif pour voir les pics, assez lent
   *  pour ne pas peser sur la boucle main process (chaque poll = 1 tick
   *  microtask + N appels syscall via pidusage). */
  private static readonly POLL_INTERVAL_MS = 2000;
  /** TTL du cache de tree : 6s = 3 polls. Au-delà, on rescanne au cas où
   *  l'agent aurait spawn de nouveaux enfants (build subprocess, tests, …). */
  private static readonly TREE_TTL_MS = 6000;

  setPid(paneId: PaneId, pid: number): void {
    // Si le pid change pour ce pane (restart), invalide aussi son cache d'arbre.
    const prev = this.pids.get(paneId);
    if (prev !== undefined && prev !== pid) this.treeCache.delete(prev);
    this.pids.set(paneId, pid);
    // Restart d'un pane → on reset son flag primed pour rejouer "calculating…".
    this.polledOnce.delete(paneId);
    this.ensureRunning();
  }

  removePane(paneId: PaneId): void {
    const prev = this.pids.get(paneId);
    if (prev !== undefined) this.treeCache.delete(prev);
    this.pids.delete(paneId);
    this.polledOnce.delete(paneId);
    if (this.pids.size === 0) this.stop();
  }

  /** Pas de panes vivants → arrête le timer. Évite des polls vides. */
  private ensureRunning(): void {
    if (this.timer || this.pids.size === 0 || this.aborted) return;
    this.timer = setInterval(() => {
      // Re-entrancy guard : si le poll précédent n'est pas terminé (pidtree
      // lent sur Win sous charge), on skip ce tick plutôt que d'empiler des
      // collects qui se marcheraient dessus pour le cache.
      if (this.collecting) return;
      this.collecting = true;
      this.collect()
        .catch((err) => log.debug('[stats] collect threw', err))
        .finally(() => {
          this.collecting = false;
        });
    }, PtyStatsCollector.POLL_INTERVAL_MS);
    // Permet à Node de quitter même si le timer est encore vivant (sinon
    // shutdown forcé bloque le main process).
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.prevCpuTimes = null;
    this.treeCache.clear();
  }

  /** Pour un PID donné, retourne pid + tous ses descendants. Sur Windows, c'est
   *  crucial : `pty.pid` pointe sur `pwsh.exe` (le wrapper) mais l'agent
   *  (`claude`/`codex`/`node.exe` enfant) tourne dans un sous-processus.
   *  Sans cette agrégation, les stats restent figées sur le shell idle.
   *
   *  Caché TREE_TTL_MS pour éviter de spawn wmic/Get-CimInstance à chaque
   *  poll (≥30ms par appel sur Windows, dominait le coût du collect). */
  private async treePids(rootPid: number): Promise<number[]> {
    const cached = this.treeCache.get(rootPid);
    const now = Date.now();
    if (cached && now - cached.ts < PtyStatsCollector.TREE_TTL_MS) {
      return cached.pids;
    }
    try {
      const children = await pidtree(rootPid);
      // pidtree renvoie uniquement les descendants — on ajoute la racine.
      const pids = [rootPid, ...children];
      this.treeCache.set(rootPid, { pids, ts: now });
      return pids;
    } catch {
      // Le process est mort ou inaccessible : on retombe sur le pid seul,
      // pidusage gérera le throw downstream. Pas de cache (process zombie).
      return [rootPid];
    }
  }

  /** Kill un arbre de processus depuis sa racine. Utilisé au shutdown pour
   *  nettoyer les orphelins ConPTY (agent → node.exe enfants qui survivraient
   *  au kill du pwsh wrapper). Best-effort : on swallow toutes les erreurs
   *  (process déjà mort, EACCES, etc.). */
  async killTrees(rootPids: number[]): Promise<void> {
    if (rootPids.length === 0) return;
    const allPids = new Set<number>();
    await Promise.all(
      rootPids.map(async (root) => {
        try {
          const tree = await pidtree(root);
          allPids.add(root);
          for (const p of tree) allPids.add(p);
        } catch {
          allPids.add(root);
        }
      })
    );
    for (const pid of allPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* déjà mort / EPERM */
      }
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
    if (this.aborted) return;
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
    if (allPids.length > 0) {
      try {
        stats = await pidusage(allPids);
      } catch {
        // Au moins un PID mort dans le batch : retombe sur du per-pid pour ne
        // pas perdre les autres. Limite la concurrence implicite — Promise.all
        // sur 50+ pidusage calls peut générer 50+ syscalls simultanés sur
        // Windows (chacun fait des appels GetProcessTimes/PSAPI).
        // Build childToRoot reverse map : treeCache est keyé par rootPid,
        // mais pidusage opère sur les child pids. Pour invalider correctement
        // le cache quand un child meurt, il faut connaître son root.
        const childToRoot = new Map<number, number>();
        for (const tree of trees) {
          for (const p of tree.pids) childToRoot.set(p, tree.rootPid);
        }
        await Promise.all(
          allPids.map(async (pid) => {
            try {
              const s = await pidusage(pid);
              stats[pid] = { cpu: s.cpu, memory: s.memory };
            } catch {
              /* pid mort — invalide le cache de l'arbre racine correspondant */
              const rootPid = childToRoot.get(pid);
              if (rootPid !== undefined) this.treeCache.delete(rootPid);
            }
          })
        );
      }
    }
    if (this.aborted) return;

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
        this.treeCache.delete(tree.rootPid);
        log.debug(`[stats] pane ${tree.paneId} (root pid=${tree.rootPid}) has no live process`);
      }
    }
    // Si la self-removal a vidé la map des panes, stoppe l'interval — sinon
    // collect() continuerait de tourner à 2Hz dans le vide indéfiniment.
    if (this.pids.size === 0) this.stop();
    if (this.aborted) return;
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
    this.aborted = true;
    this.stop();
    this.pids.clear();
    this.polledOnce.clear();
    this.treeCache.clear();
    this.removeAllListeners();
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }
}

export const ptyStats = new PtyStatsCollector();
