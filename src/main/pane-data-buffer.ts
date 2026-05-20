import { EventEmitter } from 'node:events';
import type { PaneId } from '@shared/types';
import { concatU8 } from '@shared/utils';

type Events = {
  /** Émis quand un batch de chunks a été agrégé pour un pane. Payload en
   *  Uint8Array (byte-mode) — node-pty fournit des Buffer (perf phase 2),
   *  on évite ainsi tout transcode UTF-16↔UTF-8 sur le hot path. */
  flush: [paneId: PaneId, combined: Uint8Array];
};

/**
 * Strip un tail d'échappement ANSI/VT orphelin qui peut apparaître en tête
 * d'un buffer après qu'un drop de chunks ait coupé une séquence CSI au milieu.
 *
 * Quand une frontière de chunk tombe à l'intérieur d'une séquence CSI
 * (ESC [ params final), le chunk droppé peut contenir "ESC [" et le tail
 * survivant commence par les param bytes ("0;32") + final byte ("m") — donnant
 * à xterm.js du garbage à rendre.
 *
 * Heuristique byte-mode : si le buffer commence par des param/intermediate
 * bytes (0x20–0x3f) suivis d'un final byte (0x40–0x7e) sans ESC préalable,
 * c'est un tail CSI orphelin — on coupe jusqu'au final inclus.
 */
function stripLeadingAnsiOrphan(buf: Uint8Array): Uint8Array {
  if (buf.byteLength === 0) return buf;
  const first = buf[0];
  if (first < 0x20 || first > 0x3f) return buf;
  // Avance tant qu'on voit des param/intermediate bytes (0x20-0x3f).
  let i = 1;
  while (i < buf.byteLength && buf[i] >= 0x20 && buf[i] <= 0x3f) i++;
  // Doit suivre un final byte (0x40-0x7e) pour confirmer une séquence CSI.
  if (i >= buf.byteLength) return buf;
  const final = buf[i];
  if (final < 0x40 || final > 0x7e) return buf;
  return buf.subarray(i + 1);
}

/**
 * Buffer agrégateur des chunks PTY par pane. Réduit le coût IPC quand un agent
 * streame (un seul `webContents.send` toutes les ~16ms au lieu d'un par chunk).
 *
 * Utilisation :
 *   const buf = new PaneDataBuffer();
 *   buf.on('flush', (paneId, combined) => port.postMessage(combined, [combined.buffer]));
 *   pty.onData((data) => buf.push(paneId, data));  // data: Buffer (node-pty Buffer-mode)
 *
 * Mémoire : cap dur par pane (`MAX_PANE_BYTES`). Si le renderer est freezé et
 * qu'un agent spew, on garde la TAIL (un terminal n'a besoin que des derniers
 * octets — le scrollback est déjà géré côté xterm.js). Sans ce cap, un agent
 * bavard avec renderer freeze pourrait OOM le main process.
 */
export class PaneDataBuffer extends EventEmitter {
  private buffers = new Map<PaneId, Uint8Array[]>();
  /** Octets accumulés par pane, pour appliquer le cap sans relancer byteLength. */
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

  push(paneId: PaneId, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    let buf = this.buffers.get(paneId);
    if (!buf) {
      buf = [];
      this.buffers.set(paneId, buf);
      this.sizes.set(paneId, 0);
    }
    buf.push(data);
    const size = (this.sizes.get(paneId) ?? 0) + data.byteLength;
    this.sizes.set(paneId, size);

    // Cap dur : on droppe les chunks de tête. On préserve la tail car un
    // terminal n'a aucune utilité pour des octets vieux d'1 seconde si on est
    // déjà en train d'overflow.
    if (size > PaneDataBuffer.MAX_PANE_BYTES) {
      let total = size;
      let droppedAny = false;
      while (total > PaneDataBuffer.MAX_PANE_BYTES && buf.length > 1) {
        const dropped = buf.shift();
        if (dropped !== undefined) {
          total -= dropped.byteLength;
          droppedAny = true;
        }
      }
      // Si même le dernier chunk dépasse le cap, on le tronque côté tail via
      // subarray (zero-copy view sur le même ArrayBuffer).
      if (total > PaneDataBuffer.MAX_PANE_BYTES && buf.length === 1) {
        const last = buf[0];
        const offset = last.byteLength - PaneDataBuffer.MAX_PANE_BYTES;
        buf[0] = last.subarray(offset);
        total = buf[0].byteLength;
        droppedAny = true;
      }
      // Après drop : buf[0] peut commencer par le tail d'une séquence ANSI dont
      // l'ESC+bracket était dans le chunk droppé. Strip cet orphelin pour éviter
      // que xterm.js ne rende le garbage en littéral.
      if (droppedAny && buf.length > 0) {
        const cleaned = stripLeadingAnsiOrphan(buf[0]);
        if (cleaned !== buf[0]) {
          total -= buf[0].byteLength - cleaned.byteLength;
          buf[0] = cleaned;
        }
      }
      this.sizes.set(paneId, total);
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushAll(), PaneDataBuffer.FLUSH_INTERVAL_MS);
    }
  }

  private flushAll(): void {
    this.timer = null;
    // Snapshot de la Map avant itération. emit() est synchrone — un listener
    // flush peut appeler push(), ajoutant de nouvelles entrées pour des panes
    // non encore visités. Sans snapshot, le for-of visiterait ces nouvelles
    // entrées dans la même tick, fusionnant pre-flush + post-flush dans un
    // unique message IPC envoyé out-of-order.
    for (const [paneId, chunks] of Array.from(this.buffers)) {
      if (chunks.length === 0) continue;
      const combined = concatU8(chunks);
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
