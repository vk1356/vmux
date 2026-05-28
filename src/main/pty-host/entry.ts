// Runs inside an Electron utilityProcess. Owns the single PtyManager instance
// (node-pty + PaneDataBuffer + all analysis). Bridges parentPort <-> manager:
//   inbound  HostRequest                                       -> manager method call -> HostReply
//   inbound  HostControl(attachDataPort, useDirectPort:false)  -> port released
//   inbound  HostControl(attachDataPort, useDirectPort:true)   -> port retained for paneData broadcast
//   manager  paneData event                                    -> direct port frame (if any) OR parentPort
//   manager  other meta events                                 -> parentPort post
//
// Zero-copy path (opt-in via settings.experimentalZeroCopyIpc):
//   When direct ports are attached, paneData frames are posted directly to
//   each renderer's MessagePortMain with the underlying ArrayBuffer in the
//   transfer list — zero copy, the bytes never touch main process v8. Saves
//   one structured-clone hop per 60Hz flush. Fallback to parentPort is
//   automatic when no direct port is alive (initial boot, window closed,
//   or feature flag disabled).
import { createPtyManager } from '../pty-manager';
import { encodeFrame } from '@shared/pane-data-frame';
import {
  isHostRequest, isHostControl, type HostEvent, type HostReply
} from '@shared/pty-host-protocol';

const port = process.parentPort;

/** Ports retenus pour le zero-copy path. Chaque fenêtre qui opt-in
 *  (`useDirectPort: true`) ajoute son port ici. Le broadcast `paneData`
 *  diffuse à tous les ports vivants — les renderers filtrent par subscriber
 *  (cf. paneDataBus). Quand un port émet 'close' (entanglement rompue par
 *  fermeture de window), on le retire de la liste. */
const directPorts: Electron.MessagePortMain[] = [];

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
      kind: 'hostInfo',
      where: 'paneData:first',
      message: `received ${data.byteLength}B for ${paneId} (directPorts=${directPorts.length})`
    });
  }
  // Direct-port fast path : broadcast to all attached renderer ports.
  // The frame is a contiguous ArrayBuffer (encodeFrame). MessagePortMain
  // doesn't expose ArrayBuffer transfer in its TypeScript surface (Electron
  // 42), so we send via structured-clone — bytes are copied once host→renderer
  // instead of twice (host→main + main→renderer). One v8 hop saved per flush
  // is still a real win for spew workloads.
  if (directPorts.length > 0) {
    // Encode ONCE, not once-per-port: the frame bytes are identical for every
    // window, and structured-clone copies on each postMessage anyway, so a
    // single source buffer is safe to reuse. With K detached windows this drops
    // (K-1) paneId encodes + (K-1) full payload copies per 60Hz flush.
    // NOTE: if true zero-copy ever lands (`postMessage(frame, [frame])`), build
    // the frame per-port again — the first transfer would neuter a shared buffer.
    const frame = encodeFrame(paneId, data);
    let posted = 0;
    for (const p of directPorts) {
      try {
        p.postMessage(frame);
        posted++;
      } catch {
        /* port dead — will be GC'd via 'close' handler */
      }
    }
    if (posted > 0) return;
  }
  // Fallback : parentPort route. Always works (proven structured-clone path).
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

  // Control: attach a renderer data port.
  //   useDirectPort:true  → keep the port and broadcast paneData frames on it
  //                          (zero-copy path, opt-in via settings).
  //   useDirectPort:false → release immediately (legacy path, parentPort only).
  if (isHostControl(msg) && msg.kind === 'attachDataPort') {
    const [p] = e.ports ?? [];
    if (!p) return;
    if (msg.useDirectPort === true) {
      directPorts.push(p);
      // Le 'close' est émis quand le port distant ferme (window fermée OU
      // renderer GC). On le retire du broadcast pour qu'un postMessage ne
      // jette pas silencieusement à chaque flush. start() est requis car
      // sinon le port reste paused et postMessage n'est jamais délivré
      // (Electron MessagePortMain est synchronously en pause au transfer).
      const off = (): void => {
        const idx = directPorts.indexOf(p);
        if (idx >= 0) directPorts.splice(idx, 1);
      };
      try { p.on('close', off); } catch { /* ignore */ }
      try { p.start(); } catch { /* already started */ }
      safePost({
        kind: 'hostInfo',
        where: 'attachDataPort',
        message: `direct port attached (total=${directPorts.length})`
      });
    } else {
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
