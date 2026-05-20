// Owns the utilityProcess lifecycle: fork, ready handshake, crash respawn.
// Exposes a stable MessagePort-like surface (send + onMessage) so
// PtyHostClient does not care about respawns.
import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import log from 'electron-log/main';
import { isHostReply } from '@shared/pty-host-protocol';

type IncomingHandler = (msg: unknown) => void;

export class PtyHostSupervisor {
  /** Bounded budget for the INITIAL start() handshake. Generous — the Task-1
   *  spike showed ready within ~1s. A failed/packaged spawn that never signals
   *  ready becomes a fast, logged reject (index.ts → app.exit(1)) instead of a
   *  silent infinite hang with no window. NOT applied to respawn() (Phase-2). */
  static readonly START_TIMEOUT_MS = 10000;

  private child: UtilityProcess | null = null;
  private onMessageCb: IncomingHandler | null = null;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private respawning = false;
  /** Subscribers fired AFTER every (re)spawn ready handshake completes. Used by
   *  PtyHostClient to (re-)arm its `ready` promise so RPC queued before the new
   *  child handshaked resolves once it's actually responsive. */
  private onReadyCbs: Array<() => void> = [];
  /** Subscribers fired AFTER a crash respawn ready handshake (NOT on initial
   *  start). Used by pane-data-channel.rebuildAll() to re-issue
   *  MessageChannelMain ports to the new child whose old entangled ports are
   *  dead with the previous process. */
  private onRespawnCbs: Array<() => void> = [];
  private firstReady = true;

  /** Absolute path to the bundled host entry (electron-vite emits it next to
   *  index.js — __dirname is out/main at runtime). */
  private hostPath(): string {
    return path.join(__dirname, 'pty-host.js');
  }

  start(): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log.error('[pty-host] start timed out after 10s — host did not signal ready');
        try {
          this.child?.kill();
        } catch {
          /* already dead */
        }
        reject(new Error('PTY host failed to start within 10s'));
      }, PtyHostSupervisor.START_TIMEOUT_MS);
      // Never let a clean-path timer keep the event loop alive.
      if (typeof timer.unref === 'function') timer.unref();
      // The message handler calls this.readyResolve?.() for BOTH start and
      // respawn. Wrap it here with the settle+clearTimeout guard so a normal
      // start resolves exactly once and the timer is cleared (no late reject).
      this.readyResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
    });
    this.readyPromise = p;
    this.fork();
    return p;
  }

  private fork(): void {
    const child = utilityProcess.fork(this.hostPath(), [], {
      serviceName: 'vmux-pty-host',
      stdio: 'inherit'
    });
    this.child = child;
    child.on('message', (msg: unknown) => {
      // Ready handshake: reserved reply id 0.
      if (isHostReply(msg) && msg.id === 0 && msg.result === 'ready') {
        this.readyResolve?.();
        this.readyResolve = null;
        // Fire ready subscribers (initial + every respawn). Crash isolation:
        // each callback wrapped so a thrower can't kill subsequent ones.
        for (const cb of this.onReadyCbs) {
          try { cb(); } catch (err) { log.error('[pty-host] onReady cb threw', err); }
        }
        if (!this.firstReady) {
          // Respawn-only — channels owned by the previous child are entangled
          // with a dead process and need rebuilding.
          for (const cb of this.onRespawnCbs) {
            try { cb(); } catch (err) { log.error('[pty-host] onRespawn cb threw', err); }
          }
        }
        this.firstReady = false;
        return;
      }
      this.onMessageCb?.(msg);
    });
    child.on('exit', (code) => {
      log.error(`[pty-host] exited code=${code}`);
      if (!this.respawning) this.respawn();
      else log.error('[pty-host] exit while respawning/stopping — not respawned');
    });
  }

  private respawn(): void {
    this.respawning = true;
    log.warn('[pty-host] respawning');
    this.readyPromise = new Promise((res) => (this.readyResolve = res));
    this.fork();
    void this.readyPromise.then(() => {
      this.respawning = false;
      log.info('[pty-host] respawned');
    });
  }

  send(msg: unknown): void {
    this.child?.postMessage(msg);
  }

  /** Post a message together with transferables (e.g. a MessagePortMain). The
   *  port is moved to the child process; once transferred it's no longer
   *  usable here. Used by pane-data-channel to hand the host one port half of
   *  each per-window MessageChannelMain. */
  sendWithPorts(msg: unknown, ports: readonly Electron.MessagePortMain[]): void {
    // Electron's UtilityProcess.postMessage accepts an optional transfer array
    // as the second arg. Spread cast to satisfy the variadic shape.
    (this.child as unknown as {
      postMessage: (m: unknown, t?: readonly Electron.MessagePortMain[]) => void;
    } | null)?.postMessage(msg, ports);
  }

  onMessage(cb: IncomingHandler): void {
    this.onMessageCb = cb;
  }

  /** Subscribe to every (re)spawn ready handshake. Use for state that must be
   *  re-armed on each new host instance (e.g. PtyHostClient.ready). */
  onReady(cb: () => void): void {
    this.onReadyCbs.push(cb);
  }

  /** Subscribe to crash respawn handshakes (excludes initial start). Use for
   *  resources entangled with the previous child process (e.g. data ports). */
  onRespawn(cb: () => void): void {
    this.onRespawnCbs.push(cb);
  }

  async stop(): Promise<void> {
    this.respawning = true; // suppress respawn-on-exit during shutdown
    this.child?.kill();
    this.child = null;
  }
}
