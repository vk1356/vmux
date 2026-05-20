// Single PtyHostClient instance + its supervisor, created at boot by
// index.ts (via initPtyHost) and consumed everywhere ipc.ts used the old
// `ptyManager` singleton. Split out so importing the client surface does not
// fork the utilityProcess as a module side effect (testability + boot order).
import { PtyHostSupervisor } from './pty-host-supervisor';
import { PtyHostClient } from './pty-host-client';
import { PaneDataChannelManager } from './pane-data-channel';

let instance: PtyHostClient | null = null;
let supervisor: PtyHostSupervisor | null = null;
let channelManager: PaneDataChannelManager | null = null;

export function initPtyHost(): Promise<void> {
  if (instance) return Promise.resolve();
  supervisor = new PtyHostSupervisor();
  instance = new PtyHostClient(supervisor);
  // Channel manager subscribes to supervisor.onRespawn so it can rebuild
  // every live window's data channel after a crash respawn (the old child's
  // ports die with it). Constructed before init() so the subscription is in
  // place when the FIRST handshake fires (though attachWindow is only called
  // from index.ts/ipc.ts after init resolves).
  channelManager = new PaneDataChannelManager(supervisor);
  return instance.init();
}

/** Exposed so window owners (index.ts main window, ipc.ts detached windows)
 *  can request a zero-copy data channel for their renderer. Returns null
 *  before initPtyHost() — callers should call attachWindow only after the
 *  host is initialized. */
export function getPaneDataChannelManager(): PaneDataChannelManager | null {
  return channelManager;
}

/** Proxy object so `import { ptyManager }` keeps a stable reference even
 *  though the real client is created asynchronously at boot. Methods/events
 *  are forwarded; throws if used before initPtyHost(). */
export const ptyManager: PtyHostClient = new Proxy({} as PtyHostClient, {
  get(_t, prop) {
    if (!instance) throw new Error('PTY host not initialized');
    const v = (instance as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === 'function' ? v.bind(instance) : v;
  }
});

export async function stopPtyHost(): Promise<void> {
  if (instance) await instance.stop();
}
