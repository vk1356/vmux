// Runs inside an Electron utilityProcess. Owns the single PtyManager instance
// (node-pty + PaneDataBuffer + all analysis). Bridges parentPort <-> manager:
//   inbound  HostRequest  -> manager method call -> HostReply
//   manager EventEmitter  -> HostEvent           -> parentPort
// No logic lives here beyond the bridge — PtyManager is unchanged.
import { createPtyManager } from '../pty-manager';
import { isHostRequest, type HostEvent, type HostReply } from '@shared/pty-host-protocol';

const mgr = createPtyManager();
const port = process.parentPort;

function post(msg: HostEvent | HostReply): void {
  port.postMessage(msg);
}

// Mirror every PtyManager event onto the wire. Names/payloads match the
// protocol union 1:1.
mgr.on('paneData', (paneId, data) => post({ kind: 'paneData', paneId, data }));
mgr.on('paneStatus', (sessionId, paneId, pane) =>
  post({ kind: 'paneStatus', sessionId, paneId, pane }));
mgr.on('sessionUpdate', (session) => post({ kind: 'sessionUpdate', session }));
mgr.on('urlsDetected', (paneId, urls) => post({ kind: 'urlsDetected', paneId, urls }));
mgr.on('eventDetected', (event) => post({ kind: 'eventDetected', event }));
mgr.on('paneAttention', (paneId, level) =>
  post({ kind: 'paneAttention', paneId, level }));
mgr.on('paneAgentState', (paneId, state) =>
  post({ kind: 'paneAgentState', paneId, state }));

port.on('message', (e) => {
  const req = e.data;
  if (!isHostRequest(req)) return;
  void (async () => {
    try {
      // Every proxied method exists on PtyManager with these names (verified
      // against pty-manager.ts). Dynamic dispatch by method name.
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
