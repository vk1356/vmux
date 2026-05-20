// Pure logic for routing PTY data frames from a renderer MessagePort to N
// subscribers (typically one — paneDataBus's global listener). Lives in its
// own module (no Electron globals) so the bootstrap-order / fan-out / pre-
// subscribe-buffering behavior is unit-testable.
//
// Why a buffer:
//   The preload script registers its `ipcRenderer.on(IPC.paneDataPort)` listener
//   at module load — that's before any renderer code runs. The renderer's
//   paneDataBus calls `window.cmux.panes.onData(cb)` later, during App mount.
//   If the host posts a frame in that window (bootstrap, restored sessions),
//   we'd lose bytes without a small queue.

import { decodeFrame } from '@shared/pane-data-frame';
import type { PaneId } from '@shared/types';

export type PaneDataCallback = (paneId: PaneId, data: Uint8Array) => void;

export interface PaneDataDispatcher {
  /** Feed a single frame (the ArrayBuffer transferred via the MessagePort). */
  dispatch(frame: ArrayBuffer): void;
  /** Feed an already-decoded (paneId, data) pair — used by the main-process IPC
   *  fallback transport which delivers paneId + Uint8Array directly, skipping
   *  the encodeFrame/decodeFrame round-trip. Same fan-out + preQueue semantics
   *  as `dispatch`. */
  deliver(paneId: PaneId, data: Uint8Array): void;
  /** Subscribe to all subsequent frames; on first subscribe, drains any frames
   *  buffered while no subscriber was present. Returns an unsubscribe. */
  subscribe(cb: PaneDataCallback): () => void;
}

export function createPaneDataDispatcher(): PaneDataDispatcher {
  const subscribers: PaneDataCallback[] = [];
  // Buffered before any subscriber is attached. We keep both encoded frames
  // (MessagePort path) and pre-decoded (paneId, data) pairs (main-IPC path).
  // The renderer paneDataBus subscribes once, drains both lists, then the
  // routes converge.
  let preQueueFrames: ArrayBuffer[] = [];
  let preQueuePairs: Array<{ paneId: PaneId; data: Uint8Array }> = [];

  function fanout(paneId: PaneId, data: Uint8Array): void {
    for (const cb of subscribers) {
      try {
        cb(paneId, data);
      } catch (err) {
        // One throwing subscriber must not strand frames headed for the rest.
        // Renderer console catches it; we explicitly do nothing else here.
        // eslint-disable-next-line no-console
        console.error('[pane-data-port] subscriber threw', err);
      }
    }
  }

  function deliverFrame(frame: ArrayBuffer): void {
    const { paneId, payload } = decodeFrame(frame);
    fanout(paneId, payload);
  }

  return {
    dispatch(frame: ArrayBuffer): void {
      if (subscribers.length === 0) {
        preQueueFrames.push(frame);
        return;
      }
      deliverFrame(frame);
    },
    deliver(paneId: PaneId, data: Uint8Array): void {
      if (subscribers.length === 0) {
        preQueuePairs.push({ paneId, data });
        return;
      }
      fanout(paneId, data);
    },
    subscribe(cb: PaneDataCallback): () => void {
      subscribers.push(cb);
      // On the FIRST subscribe, replay everything that arrived early — frames
      // first, then pairs, preserving the original arrival interleaving inside
      // each route (across-route order is best-effort).
      if (subscribers.length === 1) {
        if (preQueueFrames.length > 0) {
          const queued = preQueueFrames;
          preQueueFrames = [];
          for (const frame of queued) deliverFrame(frame);
        }
        if (preQueuePairs.length > 0) {
          const queued = preQueuePairs;
          preQueuePairs = [];
          for (const { paneId, data } of queued) fanout(paneId, data);
        }
      }
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }
  };
}
