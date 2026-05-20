// Runs inside an Electron utilityProcess. Owns the single PtyManager instance
// (node-pty + PaneDataBuffer + all analysis). Bridges parentPort <-> manager:
//   inbound  HostRequest                              -> manager method call -> HostReply
//   inbound  HostControl(attachDataPort) + ports[0]   -> released (Phase-2 dormant)
//   manager  paneData event                           -> parentPort post (structured-clone Uint8Array)
//   manager  other meta events                        -> parentPort post
//
// Why paneData also goes through parentPort: the Phase-2 MessagePortMain
// transport silently dropped ArrayBuffer messages on Electron 42 utilityProcess
// in our setup. Until we identify the right message shape (Buffer? wrapped
// typed-array?), all paneData traffic flows via the proven structured-clone
// IPC path — one v8 context crossing per 60Hz flush, still well below the cost
// of any analysis work which all happens here off the main thread.
import { createPtyManager } from '../pty-manager';
import {
  isHostRequest, isHostControl, type HostEvent, type HostReply
} from '@shared/pty-host-protocol';

const mgr = createPtyManager();
const port = process.parentPort;

function post(msg: HostEvent | HostReply): void {
  port.postMessage(msg);
}

// ---- Manager event mirroring -----------------------------------------------

let firstPaneDataLogged = false;
mgr.on('paneData', (paneId, data) => {
  if (!firstPaneDataLogged) {
    firstPaneDataLogged = true;
    // One-shot diagnostic: confirms pty.onData fires inside the utilityProcess
    // at all. If this log is absent in main.log after a session launch, the
    // bug is in PTY spawn / shell startup, not in transport.
    try {
      port.postMessage({
        kind: 'hostError',
        where: 'paneData:first',
        message: `received ${data.byteLength}B for ${paneId}`
      } as HostEvent);
    } catch { /* parentPort dead */ }
  }
  post({ kind: 'paneData', paneId, data });
});

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

  // Control: attach a renderer data port. Phase-2 dormant — we accept the port
  // so pane-data-channel's wiring stays sound, but release it immediately
  // (paneData currently flows via parentPort, not via this port). The infra in
  // pane-data-channel.ts/preload remains active so re-enabling is a one-line
  // change to the `mgr.on('paneData', …)` binding below.
  if (isHostControl(msg) && msg.kind === 'attachDataPort') {
    const [p] = e.ports ?? [];
    if (p) {
      try { p.close(); } catch { /* already closed */ }
    }
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
