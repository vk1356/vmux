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

const port = process.parentPort;

/** Best-effort: try to post a message; swallow any throw so a dead/closed
 *  parentPort cannot kill the host via a rethrown EventEmitter error. */
function safePost(msg: HostEvent | HostReply): void {
  try {
    port.postMessage(msg);
  } catch {
    /* parentPort dead — host is exiting anyway */
  }
}

function post(msg: HostEvent | HostReply): void {
  safePost(msg);
}

// Last-resort safety net: surface ANY uncaught exception or unhandled rejection
// to main via parentPort BEFORE the host dies. Pre-v0.13.4 a silent throw here
// killed the host on every session launch, looking from the outside like an
// empty terminal. Installed FIRST so it covers module-load errors of every
// import below.
process.on('uncaughtException', (err: Error) => {
  safePost({
    kind: 'hostError',
    where: 'uncaughtException',
    message: `${err.message}\n${err.stack ?? '(no stack)'}`
  });
});
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  safePost({
    kind: 'hostError',
    where: 'unhandledRejection',
    message: `${err.message}\n${err.stack ?? '(no stack)'}`
  });
});

const mgr = createPtyManager();

// ---- Manager event mirroring -----------------------------------------------
//
// Each callback wraps its body in try { ... } catch — a throw inside a Node
// EventEmitter listener re-throws synchronously, which would kill the host
// when uncaughtException didn't catch in time (or could create a feedback
// loop if the catcher itself emits). Defense in depth.

function safeOn<A extends unknown[]>(
  emitter: typeof mgr,
  event: string,
  fn: (...a: A) => void
): void {
  // Cast the listener through a generic EventEmitter shape so the strongly
  // typed `mgr.on(K extends keyof Events, ...)` doesn't reject our event-name
  // string at compile time. The runtime contract is identical (Node calls the
  // listener with the same args either way).
  const e = emitter as unknown as { on: (ev: string, l: (...a: unknown[]) => void) => void };
  e.on(event, (...args: unknown[]) => {
    try { fn(...(args as A)); } catch (err) {
      safePost({
        kind: 'hostError', where: `listener:${event}`,
        message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
      });
    }
  });
}

let firstPaneDataLogged = false;
safeOn<[string, Uint8Array]>(mgr, 'paneData', (paneId, data) => {
  if (!firstPaneDataLogged) {
    firstPaneDataLogged = true;
    // One-shot diagnostic: confirms pty.onData fires inside the utilityProcess
    // at all. If this log is absent in main.log after a session launch, the
    // bug is in PTY spawn / shell startup, not in transport.
    safePost({
      kind: 'hostError',
      where: 'paneData:first',
      message: `received ${data.byteLength}B for ${paneId}`
    });
  }
  post({ kind: 'paneData', paneId, data });
});

// Meta events go through parentPort too.
safeOn(mgr, 'paneStatus', (sessionId, paneId, pane) =>
  post({ kind: 'paneStatus', sessionId: sessionId as string, paneId: paneId as string, pane: pane as never }));
safeOn(mgr, 'sessionUpdate', (session) =>
  post({ kind: 'sessionUpdate', session: session as never }));
safeOn(mgr, 'urlsDetected', (paneId, urls) =>
  post({ kind: 'urlsDetected', paneId: paneId as string, urls: urls as string[] }));
safeOn(mgr, 'eventDetected', (event) =>
  post({ kind: 'eventDetected', event: event as never }));
safeOn(mgr, 'paneAttention', (paneId, level) =>
  post({ kind: 'paneAttention', paneId: paneId as string, level: level as never }));
safeOn(mgr, 'paneAgentState', (paneId, state) =>
  post({ kind: 'paneAgentState', paneId: paneId as string, state: state as never }));

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
