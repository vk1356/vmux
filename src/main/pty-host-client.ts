// main-side drop-in replacement for the `ptyManager` singleton. Same surface
// ipc.ts/index.ts consume: an EventEmitter (.on('paneData', ...) etc.) plus
// the proxied methods. RPC over PtyHostSupervisor. A synchronously-readable
// session snapshot is maintained from `sessionUpdate` events so the two
// existing sync call sites (list, sessionForPane) keep working without
// signature churn.
import { EventEmitter } from 'node:events';
import log from 'electron-log/main';
import type { PtyHostSupervisor } from './pty-host-supervisor';
import {
  isHostEvent, isHostReply, type HostEvent, type HostRequest
} from '@shared/pty-host-protocol';
import type { Session, PaneId } from '@shared/types';

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

export class PtyHostClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private snapshot: Session[] = [];
  private paneIndex = new Map<PaneId, string>();

  constructor(private sup: PtyHostSupervisor) {
    super();
    this.sup.onMessage((msg) => this.handle(msg));
  }

  /** Boot the host process; resolves once it has handshaked ready. */
  init(): Promise<void> {
    return this.sup.start();
  }

  private handle(msg: unknown): void {
    if (isHostReply(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg && msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (isHostEvent(msg)) {
      if (msg.kind === 'sessionUpdate') this.cacheSession(msg.session);
      this.dispatch(msg);
    }
  }

  /** Refresh the synchronously-readable snapshot + reverse pane index. */
  private cacheSession(session: Session): void {
    const i = this.snapshot.findIndex((s) => s.id === session.id);
    if (i >= 0) this.snapshot[i] = session;
    else this.snapshot.push(session);
    this.paneIndex.clear();
    for (const s of this.snapshot)
      for (const pid of Object.keys(s.panes)) this.paneIndex.set(pid, s.id);
  }

  /** Drop a removed session locally. No removal event is pushed by the host
   *  (PtyManager.removeSession / closePane-of-last-pane emit nothing), so the
   *  client prunes off the RPC it already proxies. */
  private prune(sessionId: string): void {
    this.snapshot = this.snapshot.filter((s) => s.id !== sessionId);
    this.paneIndex.clear();
    for (const s of this.snapshot)
      for (const pid of Object.keys(s.panes)) this.paneIndex.set(pid, s.id);
  }

  /** Translate a HostEvent into the legacy EventEmitter signature so ipc.ts's
   *  `ptyManager.on('paneData', (paneId, data) => ...)` works unchanged. */
  private dispatch(e: HostEvent): void {
    switch (e.kind) {
      case 'paneData': this.emit('paneData', e.paneId, e.data); break;
      case 'paneStatus': this.emit('paneStatus', e.sessionId, e.paneId, e.pane); break;
      case 'sessionUpdate':
        this.emit('sessionUpdate', e.session); break;
      case 'urlsDetected': this.emit('urlsDetected', e.paneId, e.urls); break;
      case 'eventDetected': this.emit('eventDetected', e.event); break;
      case 'paneAttention': this.emit('paneAttention', e.paneId, e.level); break;
      case 'paneAgentState': this.emit('paneAgentState', e.paneId, e.state); break;
    }
  }

  private call<T>(method: HostRequest['method'], args: readonly unknown[]): Promise<T> {
    const id = this.nextId++;
    const req: HostRequest = { id, method, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.sup.send(req);
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  // ---- Synchronous reads served from the snapshot ----
  list(): Session[] { return [...this.snapshot]; }
  sessionForPane(paneId: PaneId): string | undefined { return this.paneIndex.get(paneId); }

  // ---- Fire-and-forget (no reply awaited; matches current void methods) ----
  writePane(paneId: string, data: string): void {
    void this.call('writePane', [paneId, data]).catch((e) =>
      log.debug('[pty-host-client] writePane', e));
  }
  resizePane(paneId: string, size: unknown): void {
    void this.call('resizePane', [paneId, size]).catch((e) =>
      log.debug('[pty-host-client] resizePane', e));
  }
  focusPane(sessionId: string, paneId: string): void {
    void this.call('focusPane', [sessionId, paneId]);
  }
  resizeSplit(sessionId: string, splitPath: unknown, sizes: number[]): void {
    void this.call('resizeSplit', [sessionId, splitPath, sizes]);
  }
  setPaneUrl(sessionId: string, paneId: string, url: string): void {
    void this.call('setPaneUrl', [sessionId, paneId, url]);
  }

  // ---- Async (already Promise-returning in the current API) ----
  createSession(input: unknown) { return this.call('createSession', [input]); }
  removeSession(id: string) {
    const r = this.call<void>('removeSession', [id]);
    void r.then(() => this.prune(id), () => {});
    return r;
  }
  splitPane(input: unknown) { return this.call('splitPane', [input]); }
  closePane(s: string, p: string) {
    const r = this.call<Session | null>('closePane', [s, p]);
    void r.then((res) => { if (res === null) this.prune(s); }, () => {});
    return r;
  }
  relayout(s: string, preset: unknown) { return this.call('relayout', [s, preset]); }
  removeUrlFromPane(s: string, p: string, u: string) { return this.call('removeUrlFromPane', [s, p, u]); }
  renamePane(s: string, p: string, l: string) { return this.call('renamePane', [s, p, l]); }
  togglePin(s: string) { return this.call('togglePin', [s]); }
  setSessionColor(s: string, c: string | null) { return this.call('setSessionColor', [s, c]); }
  renameSession(s: string, n: string) { return this.call('renameSession', [s, n]); }
  restartAll(s: string) { return this.call('restartAll', [s]); }
  restartPane(s: string, p: string) { return this.call('restartPane', [s, p]); }
  autoRestoreSessions() { return this.call<number>('autoRestoreSessions', []); }
  shutdown() { return this.call<void>('shutdown', []); }

  /** Tear down the host process (called from before-quit after shutdown()). */
  async stop(): Promise<void> {
    await this.sup.stop();
  }
}
