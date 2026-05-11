import { EventEmitter } from 'node:events';
import type { PaneId } from '@shared/types';

type Events = {
  /** Émis quand un batch de chunks a été agrégé pour un pane. */
  flush: [paneId: PaneId, combined: string];
};

/**
 * Buffer agrégateur des chunks PTY par pane. Réduit le coût IPC quand un agent
 * streame (un seul `webContents.send` toutes les ~16ms au lieu d'un par chunk).
 *
 * Utilisation :
 *   const buf = new PaneDataBuffer();
 *   buf.on('flush', (paneId, combined) => webContents.send('pane:data', paneId, combined));
 *   pty.onData((data) => buf.push(paneId, data));
 *
 * Extraction isolée de pty-manager.ts pour faciliter les tests et clarifier la
 * responsabilité (1 fichier = 1 problème : agréger des chunks).
 *
 * Mémoire : cap dur par pane (`MAX_PANE_BYTES`). Si le renderer est freezé et
 * qu'un agent spew, on garde la TAIL (un terminal n'a besoin que des derniers
 * octets — le scrollback est déjà géré côté xterm.js). Sans ce cap, un agent
 * bavard avec renderer freeze pourrait OOM le main process.
 */
export class PaneDataBuffer extends EventEmitter {
  private buffers = new Map<PaneId, string[]>();
  /** Octets accumulés par pane, pour appliquer le cap sans relancer length(). */
  private sizes = new Map<PaneId, number>();
  private timer: NodeJS.Timeout | null = null;

  /** 60 Hz — aligné sur le refresh écran natif. xterm.js batche déjà ses
   *  writes en interne, donc descendre sous 16ms gaspille des cycles IPC sans
   *  bénéfice perceptible. */
  static readonly FLUSH_INTERVAL_MS = 16;

  /** Cap dur par pane entre deux flushs. 4 MiB = ~quelques secondes de spew
   *  brut d'un agent bavard. Au-delà, on droppe les chunks de tête (un terminal
   *  ne s'intéresse qu'à la tail). */
  static readonly MAX_PANE_BYTES = 4 * 1024 * 1024;

  push(paneId: PaneId, data: string): void {
    if (!data) return;
    let buf = this.buffers.get(paneId);
    if (!buf) {
      buf = [];
      this.buffers.set(paneId, buf);
      this.sizes.set(paneId, 0);
    }
    buf.push(data);
    const size = (this.sizes.get(paneId) ?? 0) + data.length;
    this.sizes.set(paneId, size);

    // Cap dur : on droppe les chunks de tête. On préserve la tail car un
    // terminal n'a aucune utilité pour des octets vieux d'1 seconde si on est
    // déjà en train d'overflow.
    if (size > PaneDataBuffer.MAX_PANE_BYTES) {
      let total = size;
      while (total > PaneDataBuffer.MAX_PANE_BYTES && buf.length > 1) {
        const dropped = buf.shift();
        if (dropped !== undefined) total -= dropped.length;
      }
      // Si même le dernier chunk dépasse le cap, on le tronque côté tail.
      if (total > PaneDataBuffer.MAX_PANE_BYTES && buf.length === 1) {
        const last = buf[0];
        buf[0] = last.slice(last.length - PaneDataBuffer.MAX_PANE_BYTES);
        total = buf[0].length;
      }
      this.sizes.set(paneId, total);
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushAll(), PaneDataBuffer.FLUSH_INTERVAL_MS);
    }
  }

  private flushAll(): void {
    this.timer = null;
    for (const [paneId, chunks] of this.buffers) {
      if (chunks.length === 0) continue;
      const combined = chunks.length === 1 ? chunks[0] : chunks.join('');
      // Delete plutôt que set([], ...) : un pane churn rapide (ouverture/
      // fermeture) ne laisse pas de slots vides dans la Map. push() lazily
      // re-créera l'entrée à la prochaine arrivée de data.
      this.buffers.delete(paneId);
      this.sizes.delete(paneId);
      this.emit('flush', paneId, combined);
    }
  }

  /** Force un flush synchrone immédiat (utile avant un teardown propre où on
   *  veut que le renderer reçoive les derniers octets avant d'unmount). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushAll();
  }

  delete(paneId: PaneId): void {
    this.buffers.delete(paneId);
    this.sizes.delete(paneId);
  }

  shutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffers.clear();
    this.sizes.clear();
    this.removeAllListeners();
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }
}
