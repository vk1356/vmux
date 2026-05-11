// Bus IPC unique pour les chunks de PTY.
//
// Avant : chaque <TerminalPane> enregistrait `window.cmux.panes.onData`. Avec
// N panes ouverts, chaque chunk traversait N callbacks renderer (filtre par
// paneId, dispatch, return). Les chunks sont déjà batchés par le main, mais
// la duplication des listeners gaspille du CPU et des allocations IPC.
//
// Maintenant : 1 listener global au boot du renderer + une Map paneId →
// handler. Les <TerminalPane> souscrivent/désouscrivent via ce bus.

import type { PaneId } from '@shared/types';

type Handler = (data: string) => void;

const handlers = new Map<PaneId, Handler>();
/** Buffer pour les chunks reçus avant qu'un handler ne soit subscribed
 *  (cas du restart : le PTY peut écrire avant que <TerminalPane> ne s'init). */
const pending = new Map<PaneId, string[]>();
let installed = false;
let unsub: (() => void) | null = null;

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  unsub = window.cmux.panes.onData((paneId, data) => {
    const h = handlers.get(paneId);
    if (h) {
      h(data);
      return;
    }
    let buf = pending.get(paneId);
    if (!buf) {
      buf = [];
      pending.set(paneId, buf);
    }
    buf.push(data);
    // Cap pour éviter une fuite mémoire si un pane n'est jamais monté.
    if (buf.length > 256) buf.splice(0, buf.length - 256);
  });
}

/** S'abonne aux chunks pour un pane. Retourne la fonction de désinscription
 *  (à appeler au unmount). Délivre immédiatement le pending buffer s'il existe. */
export function subscribePaneData(paneId: PaneId, handler: Handler): () => void {
  ensureInstalled();
  handlers.set(paneId, handler);
  const buf = pending.get(paneId);
  if (buf && buf.length > 0) {
    pending.delete(paneId);
    for (const chunk of buf) handler(chunk);
  }
  return () => {
    handlers.delete(paneId);
    // Ne purge PAS le pending buffer : une remount rapide peut vouloir le rejouer.
    // Il sera nettoyé au prochain unmount du même pane.
  };
}

/** À appeler quand un pane est définitivement fermé (côté store) — purge le
 *  buffer pending pour libérer la mémoire.
 *  Note : appelé depuis `removeSession` (couvre la fermeture de session) ET
 *  via TerminalPane lors d'un closePane individuel pour éviter les leaks. */
export function clearPaneData(paneId: PaneId): void {
  pending.delete(paneId);
  handlers.delete(paneId);
}

/** Diagnostic — peut être appelé depuis la devtools si besoin. */
export function _paneDataBusStats(): { handlers: number; pending: number } {
  return { handlers: handlers.size, pending: pending.size };
}

/** Cleanup global (HMR / unload). */
export function teardownPaneDataBus(): void {
  unsub?.();
  unsub = null;
  installed = false;
  handlers.clear();
  pending.clear();
}
