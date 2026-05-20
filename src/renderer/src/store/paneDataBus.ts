// Bus IPC unique pour les chunks de PTY.
//
// Avant : chaque <TerminalPane> enregistrait `window.cmux.panes.onData`. Avec
// N panes ouverts, chaque chunk traversait N callbacks renderer (filtre par
// paneId, dispatch, return). Les chunks sont déjà batchés par le main
// (PaneDataBuffer, flush 60 Hz), mais la duplication des listeners gaspille du
// CPU et des allocations IPC.
//
// Maintenant : 1 listener global au boot du renderer + une Map paneId →
// handler. Les <TerminalPane> souscrivent/désouscrivent via ce bus.
//
// Note batching : on NE coalesce PAS en RAF côté renderer — le main batche
// déjà à 60 Hz, et xterm.js a son propre WriteBuffer interne. Ajouter une
// couche RAF ici ajouterait de la latence keystroke→echo sans bénéfice.

import type { PaneId } from '@shared/types';
import { concatU8 } from '@shared/utils';

type Handler = (data: Uint8Array) => void;

/** Token interne pour identifier un subscribe spécifique. Évite qu'un unsub
 *  tardif (après remount rapide) ne supprime le handler de la *nouvelle*
 *  souscription. */
interface Subscription {
  readonly paneId: PaneId;
  readonly handler: Handler;
}

const subscriptions = new Map<PaneId, Subscription>();

/** Buffer pour les chunks reçus avant qu'un handler ne soit subscribed
 *  (cas du restart : le PTY peut écrire avant que <TerminalPane> ne s'init).
 *  Cap par BYTES (pas par chunks) — un seul gros chunk peut faire MB. */
const pending = new Map<PaneId, { chunks: Uint8Array[]; bytes: number }>();

/** Cap mémoire global du pending par pane. 256 KB est généreux : le pending
 *  ne sert qu'à couvrir la fenêtre entre un restart PTY (côté main) et le
 *  premier mount du <TerminalPane> côté renderer — typiquement < 50 ms. */
const PENDING_MAX_BYTES = 256 * 1024;

/** Ring d'octets retenus par pane — perf phase 4. Conserve les chunks
 *  délivrés/queued pour permettre un "replay" complet quand un Terminal
 *  hidden > 30 s est dispose() puis re-mount (virtualization). Le ring est
 *  capé en octets ; au-delà on droppe la tête sur frontière de chunk et on
 *  marque `truncated` — le snapshot suivant préfixera un reset xterm (`\x1bc`)
 *  pour que la re-attache parte d'un état propre au lieu de rendre du
 *  garbage mid-stream. */
const retained = new Map<PaneId, { chunks: Uint8Array[]; bytes: number; truncated: boolean }>();
const RETAIN_CAP_BYTES = 2 * 1024 * 1024;

function teeRetained(paneId: PaneId, data: Uint8Array): void {
  let buf = retained.get(paneId);
  if (!buf) {
    buf = { chunks: [], bytes: 0, truncated: false };
    retained.set(paneId, buf);
  }
  buf.chunks.push(data);
  buf.bytes += data.byteLength;
  // Drop on chunk boundaries (preserves ANSI state across the cut where
  // possible — never mid-sequence). The reset prefix in snapshotRetained
  // covers the resulting parser-state gap.
  while (buf.bytes > RETAIN_CAP_BYTES && buf.chunks.length > 1) {
    const dropped = buf.chunks.shift();
    if (dropped !== undefined) {
      buf.bytes -= dropped.byteLength;
      buf.truncated = true;
    }
  }
}

let installed = false;
let unsubIpc: (() => void) | null = null;
/** Quand la fenêtre est masquée (Win+D, autre desktop, etc.), inutile de payer
 *  le coût xterm parser sur chaque chunk — le rendu est invisible. On bascule
 *  alors tous les chunks dans `pending`, qui sera flushé au prochain repaint.
 *  Évite un freeze CPU lourd quand un agent spew en arrière-plan. */
let windowHidden = typeof document !== 'undefined' ? document.hidden : false;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const wasHidden = windowHidden;
    windowHidden = document.hidden;
    // Au retour de visible : flush les pending vers leur handler abonné.
    if (wasHidden && !windowHidden) {
      for (const [paneId, buf] of Array.from(pending)) {
        const sub = subscriptions.get(paneId);
        if (!sub || buf.chunks.length === 0) continue;
        pending.delete(paneId);
        // Concat unique : un seul write xterm — moins de WriteBuffer enqueue.
        sub.handler(concatU8(buf.chunks));
      }
    }
  });
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  unsubIpc = window.cmux.panes.onData((paneId, data) => {
    // Tee to the retained ring on EVERY chunk (delivered live OR queued in
    // pending). The retained ring is the single source of truth for
    // virtualization replay — survives Terminal.dispose() because it lives
    // outside the React component.
    teeRetained(paneId, data);

    const sub = subscriptions.get(paneId);
    // Si fenêtre masquée, on bypass le handler et accumule. xterm.write() coûte
    // ~5-50µs/chunk même invisible (parser ANSI, WriteBuffer). Sur 100 panes
    // qui spew, c'est 5-50ms par flush — détectable en jank.
    if (sub && !windowHidden) {
      sub.handler(data);
      return;
    }
    let buf = pending.get(paneId);
    if (!buf) {
      buf = { chunks: [], bytes: 0 };
      pending.set(paneId, buf);
    }
    buf.chunks.push(data);
    buf.bytes += data.byteLength;
    // Cap par octets : on droppe la tête (un terminal qui n'est pas encore
    // monté n'a aucune utilité à voir des octets vieux d'1 seconde si on est
    // déjà en train d'overflow).
    while (buf.bytes > PENDING_MAX_BYTES && buf.chunks.length > 1) {
      const dropped = buf.chunks.shift();
      if (dropped !== undefined) buf.bytes -= dropped.byteLength;
    }
  });
}

/** Snapshot the retained byte ring for a pane — used by virtualization to
 *  replay state into a freshly re-instantiated Terminal after a hidden-pane
 *  dispose. When the ring is truncated (cap hit, head dropped), prefix a
 *  full-reset sequence (`\x1bc` = RIS) so xterm restarts its parser cleanly
 *  instead of rendering whatever ANSI state would be implied by the tail. */
export function snapshotRetained(paneId: PaneId): Uint8Array | null {
  const buf = retained.get(paneId);
  if (!buf || buf.chunks.length === 0) return null;
  const body = concatU8(buf.chunks);
  if (!buf.truncated) return body;
  const reset = new Uint8Array([0x1b, 0x63]); // ESC c — full terminal reset
  const out = new Uint8Array(reset.byteLength + body.byteLength);
  out.set(reset, 0);
  out.set(body, reset.byteLength);
  return out;
}

/** S'abonne aux chunks pour un pane. Retourne la fonction de désinscription
 *  (à appeler au unmount). Délivre immédiatement le pending buffer s'il existe.
 *
 *  Sécurité remount rapide : on stocke un token de subscription. L'unsub ne
 *  supprime l'entrée que si la subscription courante est toujours la nôtre.
 *  Sans ça, un cycle (sub A → unmount A → sub B → cleanup A retardé) pourrait
 *  supprimer le handler de B et perdre des octets. */
export function subscribePaneData(paneId: PaneId, handler: Handler): () => void {
  ensureInstalled();
  const sub: Subscription = { paneId, handler };
  subscriptions.set(paneId, sub);
  const buf = pending.get(paneId);
  if (buf && buf.chunks.length > 0) {
    pending.delete(paneId);
    for (const chunk of buf.chunks) handler(chunk);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Ne désinscrit QUE si la subscription courante est encore la nôtre.
    if (subscriptions.get(paneId) === sub) {
      subscriptions.delete(paneId);
    }
    // Ne purge PAS le pending buffer : une remount rapide peut vouloir le rejouer.
    // Il sera nettoyé via clearPaneData (pane fermé) ou TTL implicite (entrée
    // jamais relue → mémoire négligeable, capée à PENDING_MAX_BYTES).
  };
}

/** À appeler quand un pane est définitivement fermé (côté store) — purge le
 *  buffer pending pour libérer la mémoire.
 *  Note : appelé depuis `removeSession` (couvre la fermeture de session) ET
 *  via `upsertSession` lors d'un closePane individuel pour éviter les leaks. */
export function clearPaneData(paneId: PaneId): void {
  pending.delete(paneId);
  subscriptions.delete(paneId);
  retained.delete(paneId);
}

/** Diagnostic — peut être appelé depuis la devtools si besoin. */
export function _paneDataBusStats(): {
  handlers: number;
  pending: number;
  pendingBytes: number;
  retained: number;
  retainedBytes: number;
} {
  let pendingBytes = 0;
  for (const buf of pending.values()) pendingBytes += buf.bytes;
  let retainedBytes = 0;
  for (const buf of retained.values()) retainedBytes += buf.bytes;
  return {
    handlers: subscriptions.size,
    pending: pending.size,
    pendingBytes,
    retained: retained.size,
    retainedBytes
  };
}

/** Cleanup global (HMR / unload). */
export function teardownPaneDataBus(): void {
  unsubIpc?.();
  unsubIpc = null;
  installed = false;
  subscriptions.clear();
  pending.clear();
  retained.clear();
}

// HMR : sans dispose hook, le module re-évalué laisserait l'ancien listener IPC
// installé pointant sur l'ancienne Map subscriptions (fermeture morte) — fuite
// dev-only mais bruyante (warnings React + chunks perdus). En prod ce bloc est
// tree-shaké car `import.meta.hot` est undefined.
if (import.meta.hot) {
  import.meta.hot.dispose(() => teardownPaneDataBus());
}
