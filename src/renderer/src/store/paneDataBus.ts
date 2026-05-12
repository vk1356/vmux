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

type Handler = (data: string) => void;

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
const pending = new Map<PaneId, { chunks: string[]; bytes: number }>();

/** Cap mémoire global du pending par pane. 256 KB est généreux : le pending
 *  ne sert qu'à couvrir la fenêtre entre un restart PTY (côté main) et le
 *  premier mount du <TerminalPane> côté renderer — typiquement < 50 ms. */
const PENDING_MAX_BYTES = 256 * 1024;

let installed = false;
let unsubIpc: (() => void) | null = null;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  unsubIpc = window.cmux.panes.onData((paneId, data) => {
    const sub = subscriptions.get(paneId);
    if (sub) {
      sub.handler(data);
      return;
    }
    let buf = pending.get(paneId);
    if (!buf) {
      buf = { chunks: [], bytes: 0 };
      pending.set(paneId, buf);
    }
    buf.chunks.push(data);
    buf.bytes += data.length;
    // Cap par octets : on droppe la tête (un terminal qui n'est pas encore
    // monté n'a aucune utilité à voir des octets vieux d'1 seconde si on est
    // déjà en train d'overflow).
    while (buf.bytes > PENDING_MAX_BYTES && buf.chunks.length > 1) {
      const dropped = buf.chunks.shift();
      if (dropped !== undefined) buf.bytes -= dropped.length;
    }
  });
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
}

/** Diagnostic — peut être appelé depuis la devtools si besoin. */
export function _paneDataBusStats(): {
  handlers: number;
  pending: number;
  pendingBytes: number;
} {
  let pendingBytes = 0;
  for (const buf of pending.values()) pendingBytes += buf.bytes;
  return { handlers: subscriptions.size, pending: pending.size, pendingBytes };
}

/** Cleanup global (HMR / unload). */
export function teardownPaneDataBus(): void {
  unsubIpc?.();
  unsubIpc = null;
  installed = false;
  subscriptions.clear();
  pending.clear();
}

// HMR : sans dispose hook, le module re-évalué laisserait l'ancien listener IPC
// installé pointant sur l'ancienne Map subscriptions (fermeture morte) — fuite
// dev-only mais bruyante (warnings React + chunks perdus). En prod ce bloc est
// tree-shaké car `import.meta.hot` est undefined.
if (import.meta.hot) {
  import.meta.hot.dispose(() => teardownPaneDataBus());
}
