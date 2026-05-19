// Single PtyHostClient instance + its supervisor, created at boot by
// index.ts (via initPtyHost) and consumed everywhere ipc.ts used the old
// `ptyManager` singleton. Split out so importing the client surface does not
// fork the utilityProcess as a module side effect (testability + boot order).
import { PtyHostSupervisor } from './pty-host-supervisor';
import { PtyHostClient } from './pty-host-client';

let instance: PtyHostClient | null = null;

export function initPtyHost(): Promise<void> {
  if (instance) return Promise.resolve();
  instance = new PtyHostClient(new PtyHostSupervisor());
  return instance.init();
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
