import { EventEmitter } from 'node:events';
import type { PaneId } from '@shared/types';
import { concatU8 } from '@shared/utils';

type Events = {
  /** Émis quand un batch de chunks a été agrégé pour un pane. Payload en
   *  Uint8Array (byte-mode) — node-pty fournit des Buffer (perf phase 2),
   *  on évite ainsi tout transcode UTF-16↔UTF-8 sur le hot path. */
  flush: [paneId: PaneId, combined: Uint8Array];
};

/** Cause d'un flush — utile pour benchs / debugging / instrumentation.
 *  `interactive` : flush immédiat synchrone déclenché par la heuristique
 *    Phase-3 (petit chunk après silence) → frappe→écho sans pénalité 16 ms.
 *  `coalesced`   : flush via le timer 60 Hz — spew agent, débit prioritaire.
 *  `manual`      : `buf.flush()` appelé explicitement (shutdown gracieux). */
export type FlushReason = 'interactive' | 'coalesced' | 'manual';

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
  /** Date.now() du dernier push par pane — sert au heuristique adaptive flush
   *  Phase 3 (echo immédiat si petit chunk arrive après une longue silence). */
  private lastActivityAt = new Map<PaneId, number>();
  private timer: NodeJS.Timeout | null = null;

  /** Cause du dernier flush émis. Exposé pour les benchs/tests (l'API
   *  fonctionnelle reste l'événement `flush`). Initialisé à 'coalesced' —
   *  valeur neutre avant tout flush. */
  lastFlushReason: FlushReason = 'coalesced';

  /** 60 Hz — aligné sur le refresh écran natif. xterm.js batche déjà ses
   *  writes en interne, donc descendre sous 16ms gaspille des cycles IPC sans
   *  bénéfice perceptible. */
  static readonly FLUSH_INTERVAL_MS = 16;

  /** Cap dur par pane entre deux flushs. 4 MiB = ~quelques secondes de spew
   *  brut d'un agent bavard. Au-delà, on droppe les chunks de tête (un terminal
   *  ne s'intéresse qu'à la tail). */
  static readonly MAX_PANE_BYTES = 4 * 1024 * 1024;

  /** Adaptive flush — Phase 3 : un petit chunk (< THRESHOLD) qui arrive après
   *  > SILENCE_WINDOW_MS de silence est flushé IMMÉDIATEMENT et synchroniquement
   *  au lieu d'attendre le tick 16 ms. Profil cible : keystroke→echo. Pendant
   *  le spew (chunks > THRESHOLD ou succession rapide), on reste sur le timer
   *  pour bénéficier de la coalescence (débit prioritaire).
   *
   *  Seuils calibrés v0.13.7 pour battre la latence PowerShell native :
   *    - SILENCE_WINDOW = 16 ms (≤ 1 frame). Un typist à 60 Hz (16ms/touche)
   *      déclenche encore l'interactive flush — avant à 50ms le 2e keystroke
   *      tombait dans le timer 16ms et accumulait 16-30ms de latence.
   *    - THRESHOLD     = 2048 B. Un prompt pwsh complet (timestamp + cwd +
   *      ANSI styling) tient < 1KB, donc tout le re-paint du prompt après un
   *      keystroke part en interactive flush au lieu d'attendre le timer. */
  static readonly INTERACTIVE_THRESHOLD = 2048;
  static readonly SILENCE_WINDOW_MS = 16;

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

    // Adaptive flush (Phase 3) : un chunk < THRESHOLD après > SILENCE_WINDOW_MS
    // de silence est flushé synchroniquement maintenant — l'écho clavier ne paie
    // jamais le 16 ms du timer. Pendant un spew (chunks > 512 ou succession
    // rapide), silence est court → on retombe sur la coalescence.
    // La toute première push pour un pane (lastActivityAt absent) prend le
    // chemin timer : pas de "silence préalable" à mesurer, et ça évite que
    // les chunks de boot (output initial shell) ne déclenchent N flushs en
    // série au lieu d'un seul.
    const now = Date.now();
    const hadActivity = this.lastActivityAt.has(paneId);
    const lastAt = this.lastActivityAt.get(paneId) ?? now;
    const silence = now - lastAt;
    this.lastActivityAt.set(paneId, now);
    const currentSize = this.sizes.get(paneId) ?? 0;
    if (
      hadActivity &&
      currentSize < PaneDataBuffer.INTERACTIVE_THRESHOLD &&
      silence > PaneDataBuffer.SILENCE_WINDOW_MS
    ) {
      this.flushPane(paneId, 'interactive');
      return;
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushAll('coalesced'), PaneDataBuffer.FLUSH_INTERVAL_MS);
    }
  }

  /** Flush UN pane synchroniquement. Helper partagé par flushAll (boucle) et
   *  par le chemin adaptive flush (echo immédiat). */
  private flushPane(paneId: PaneId, reason: FlushReason): void {
    const chunks = this.buffers.get(paneId);
    if (!chunks || chunks.length === 0) return;
    const combined = concatU8(chunks);
    this.buffers.delete(paneId);
    this.sizes.delete(paneId);
    this.lastFlushReason = reason;
    this.emit('flush', paneId, combined);
  }

  private flushAll(reason: FlushReason): void {
    this.timer = null;
    // Snapshot de la Map avant itération. emit() est synchrone — un listener
    // flush peut appeler push(), ajoutant de nouvelles entrées pour des panes
    // non encore visités. Sans snapshot, le for-of visiterait ces nouvelles
    // entrées dans la même tick, fusionnant pre-flush + post-flush dans un
    // unique message IPC envoyé out-of-order.
    for (const paneId of Array.from(this.buffers.keys())) {
      this.flushPane(paneId, reason);
    }
  }

  /** Force un flush synchrone immédiat (utile avant un teardown propre où on
   *  veut que le renderer reçoive les derniers octets avant d'unmount). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushAll('manual');
  }

  delete(paneId: PaneId): void {
    this.buffers.delete(paneId);
    this.sizes.delete(paneId);
    this.lastActivityAt.delete(paneId);
  }

  shutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffers.clear();
    this.sizes.clear();
    this.lastActivityAt.clear();
    this.removeAllListeners();
  }

  override on<K extends keyof Events>(e: K, l: (...a: Events[K]) => void): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  override emit<K extends keyof Events>(e: K, ...a: Events[K]): boolean {
    return super.emit(e, ...a);
  }
}
