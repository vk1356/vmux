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
 */
export class PaneDataBuffer extends EventEmitter {
  private buffers = new Map<PaneId, string[]>();
  private timer: NodeJS.Timeout | null = null;

  /** 60 Hz — aligné sur le refresh écran natif. xterm.js batche déjà ses
   *  writes en interne, donc descendre sous 16ms gaspille des cycles IPC sans
   *  bénéfice perceptible. */
  static readonly FLUSH_INTERVAL_MS = 16;

  push(paneId: PaneId, data: string): void {
    let buf = this.buffers.get(paneId);
    if (!buf) {
      buf = [];
      this.buffers.set(paneId, buf);
    }
    buf.push(data);
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
      this.emit('flush', paneId, combined);
    }
  }

  delete(paneId: PaneId): void {
    this.buffers.delete(paneId);
  }

  shutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffers.clear();
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }
}
