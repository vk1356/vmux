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
  /** Subscribe to all subsequent frames; on first subscribe, drains any frames
   *  buffered while no subscriber was present. Returns an unsubscribe. */
  subscribe(cb: PaneDataCallback): () => void;
}

export function createPaneDataDispatcher(): PaneDataDispatcher {
  const subscribers: PaneDataCallback[] = [];
  let preQueue: ArrayBuffer[] = [];

  function deliver(frame: ArrayBuffer): void {
    const { paneId, payload } = decodeFrame(frame);
    for (const cb of subscribers) {
      try {
        cb(paneId, payload);
      } catch (err) {
        // One throwing subscriber must not strand frames headed for the rest.
        // Renderer console catches it; we explicitly do nothing else here.
        // eslint-disable-next-line no-console
        console.error('[pane-data-port] subscriber threw', err);
      }
    }
  }

  return {
    dispatch(frame: ArrayBuffer): void {
      if (subscribers.length === 0) {
        preQueue.push(frame);
        return;
      }
      deliver(frame);
    },
    subscribe(cb: PaneDataCallback): () => void {
      subscribers.push(cb);
      // On the FIRST subscribe, replay everything that arrived early.
      if (subscribers.length === 1 && preQueue.length > 0) {
        const queued = preQueue;
        preQueue = [];
        for (const frame of queued) deliver(frame);
      }
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }
  };
}
