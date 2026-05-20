// Runs inside an Electron utilityProcess. Owns the single PtyManager instance
// (node-pty + PaneDataBuffer + all analysis). Bridges parentPort <-> manager:
//   inbound  HostRequest                              -> manager method call -> HostReply
//   inbound  HostControl(attachDataPort) + ports[0]   -> store renderer port
//   manager  paneData event                           -> dataPort.postMessage(frame, [frame])
//   manager  other meta events                        -> parentPort post (low-freq, structured-clone)
//
// The PTY byte path bypasses `main` entirely via transferred MessagePortMain —
// frame.buffer is moved to the renderer, never deserialized on the main thread.
import { createPtyManager } from '../pty-manager';
import {
  isHostRequest, isHostControl, type HostEvent, type HostReply
} from '@shared/pty-host-protocol';
import { encodeFrame } from '@shared/pane-data-frame';

const mgr = createPtyManager();
const port = process.parentPort;

function post(msg: HostEvent | HostReply): void {
  port.postMessage(msg);
}

// ---- Data ports (per-window MessagePortMain hands from main) ---------------

const dataPorts: Electron.MessagePortMain[] = [];
/** Frames buffered before any data port attaches. The host may emit paneData
 *  during the first ~ms after fork — before main has wired a window's channel.
 *  Bounded 1 MiB head-drop so a transient renderer outage can't OOM the host. */
const preQueue: ArrayBuffer[] = [];
let preQueueBytes = 0;
const PRE_QUEUE_CAP = 1024 * 1024;

function enqueuePre(frame: ArrayBuffer): void {
  preQueue.push(frame);
  preQueueBytes += frame.byteLength;
  while (preQueueBytes > PRE_QUEUE_CAP && preQueue.length > 1) {
    const dropped = preQueue.shift();
    if (dropped) preQueueBytes -= dropped.byteLength;
  }
}

/** Electron's MessagePortMain.postMessage TS types only declare MessagePortMain[]
 *  as transferable, but the underlying Chromium MessagePort accepts ArrayBuffer
 *  transferables too (the entire point of this transport). Narrow cast so the
 *  hot path can pass a frame's ArrayBuffer for true zero-copy detach. */
type AnyTransferable = ArrayBuffer | Electron.MessagePortMain;
type AnyTransferablePort = {
  postMessage: (msg: unknown, transfer?: readonly AnyTransferable[]) => void;
  start: () => void;
  on: Electron.MessagePortMain['on'];
};
const asAnyPort = (p: Electron.MessagePortMain): AnyTransferablePort =>
  p as unknown as AnyTransferablePort;

function flushPreQueueTo(p: Electron.MessagePortMain): void {
  if (preQueue.length === 0) return;
  const ap = asAnyPort(p);
  for (const f of preQueue) {
    try {
      ap.postMessage(f, [f]);
    } catch {
      /* port closed mid-drain — caller will prune */
    }
  }
  preQueue.length = 0;
  preQueueBytes = 0;
}

function postFrame(paneId: string, payload: Uint8Array): void {
  // Single-window fast path: one encode, one transfer, true zero-copy.
  if (dataPorts.length === 1) {
    const frame = encodeFrame(paneId, payload);
    try {
      asAnyPort(dataPorts[0]).postMessage(frame, [frame]);
    } catch {
      // Port closed unexpectedly; the 'close' handler will prune. We don't
      // re-queue: the buffer's coalescing absorbs the gap, and a respawn
      // restart will replay state via sessionUpdate.
    }
    return;
  }
  if (dataPorts.length === 0) {
    enqueuePre(encodeFrame(paneId, payload));
    return;
  }
  // Multi-window fan-out: one frame per port (each transferable independently).
  // Allocation cost paid only when a detached window exists.
  for (const p of dataPorts) {
    const frame = encodeFrame(paneId, payload);
    try {
      asAnyPort(p).postMessage(frame, [frame]);
    } catch {
      /* prune via close handler */
    }
  }
}

// ---- Manager event mirroring -----------------------------------------------

// paneData: the hot path. Frames go on the data port (zero-copy), NOT parentPort.
mgr.on('paneData', (paneId, data) => postFrame(paneId, data));

// Meta events stay on parentPort (low frequency, structured-clone is fine).
mgr.on('paneStatus', (sessionId, paneId, pane) =>
  post({ kind: 'paneStatus', sessionId, paneId, pane }));
mgr.on('sessionUpdate', (session) => post({ kind: 'sessionUpdate', session }));
mgr.on('urlsDetected', (paneId, urls) => post({ kind: 'urlsDetected', paneId, urls }));
mgr.on('eventDetected', (event) => post({ kind: 'eventDetected', event }));
mgr.on('paneAttention', (paneId, level) =>
  post({ kind: 'paneAttention', paneId, level }));
mgr.on('paneAgentState', (paneId, state) =>
  post({ kind: 'paneAgentState', paneId, state }));

// ---- Inbound from main: control + RPC --------------------------------------

port.on('message', (e) => {
  const msg = e.data;

  // Control: attach a renderer data port. The MessagePortMain itself is in
  // e.ports[0] (transferred by main via sendWithPorts in pane-data-channel).
  if (isHostControl(msg) && msg.kind === 'attachDataPort') {
    const [p] = e.ports ?? [];
    if (!p) return;
    p.on('close', () => {
      const idx = dataPorts.indexOf(p);
      if (idx >= 0) dataPorts.splice(idx, 1);
    });
    p.start();
    dataPorts.push(p);
    // First port attaching: drain whatever buffered during the fork window.
    if (dataPorts.length === 1) flushPreQueueTo(p);
    return;
  }

  if (!isHostRequest(msg)) return;
  const req = msg;
  void (async () => {
    try {
      const fn = (mgr as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method];
      if (typeof fn !== 'function') {
        post({ id: req.id, error: `unknown method ${req.method}` });
        return;
      }
      const result = await fn.apply(mgr, req.args as unknown[]);
      post({ id: req.id, result });
    } catch (err) {
      post({ id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

// Reserved id 0 = "host ready" handshake (never used by real requests, which
// start at 1 in PtyHostClient).
post({ id: 0, result: 'ready' });
