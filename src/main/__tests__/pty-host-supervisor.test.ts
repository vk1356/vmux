import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks --------------------------------------------------------------
// electron-log/main: log.error/warn/info as spies.
vi.mock('electron-log/main', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}));

// electron: utilityProcess.fork returns a controllable fake child. The test
// captures the `on('message', cb)` handler so it can drive (or withhold) the
// ready handshake.
let lastChild: {
  on: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _handlers: Record<string, (arg: unknown) => void>;
};

function makeFakeChild(): typeof lastChild {
  const handlers: Record<string, (arg: unknown) => void> = {};
  return {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      handlers[event] = cb;
    }),
    postMessage: vi.fn(),
    kill: vi.fn(),
    _handlers: handlers
  };
}

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      lastChild = makeFakeChild();
      return lastChild;
    })
  }
}));

import { PtyHostSupervisor } from '../pty-host-supervisor';
import log from 'electron-log/main';

describe('PtyHostSupervisor.start() bounded timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout error and kills the child if ready never arrives', async () => {
    const sup = new PtyHostSupervisor();
    const p = sup.start();
    // Attach a catch synchronously so the rejection is never "unhandled".
    const assertion = expect(p).rejects.toThrow('PTY host failed to start within 10s');

    // No ready message emitted. Advance past the 10s budget.
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(lastChild.kill).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      '[pty-host] start timed out after 10s — host did not signal ready'
    );
  });

  it('resolves on the ready handshake and clears the timer (no late reject)', async () => {
    const sup = new PtyHostSupervisor();
    const p = sup.start();

    // Drive the ready handshake (reserved reply id 0).
    lastChild._handlers.message?.({ id: 0, result: 'ready' });

    await expect(p).resolves.toBeUndefined();

    // Advancing past the timeout must NOT trigger a late rejection or
    // log.error — the timer should have been cleared on resolve.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(log.error).not.toHaveBeenCalledWith(
      '[pty-host] start timed out after 10s — host did not signal ready'
    );
    expect(lastChild.kill).not.toHaveBeenCalled();
  });
});

describe('PtyHostSupervisor port transfer + (re)spawn hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sendWithPorts forwards both message and transfer list to the child', async () => {
    const sup = new PtyHostSupervisor();
    const p = sup.start();
    lastChild._handlers.message?.({ id: 0, result: 'ready' });
    await p;

    const fakePort = { __port: true } as unknown as Electron.MessagePortMain;
    sup.sendWithPorts({ kind: 'attachDataPort' }, [fakePort]);

    // postMessage called with (msg, [port]) — the variadic 2nd arg is the
    // transfer list expected by Electron's UtilityProcess.postMessage.
    expect(lastChild.postMessage).toHaveBeenCalledWith(
      { kind: 'attachDataPort' },
      [fakePort]
    );
  });

  it('onReady fires on initial start AND on respawn', async () => {
    const sup = new PtyHostSupervisor();
    const cb = vi.fn();
    sup.onReady(cb);

    const p = sup.start();
    lastChild._handlers.message?.({ id: 0, result: 'ready' });
    await p;
    expect(cb).toHaveBeenCalledTimes(1);

    // Simulate crash → supervisor respawns; another ready handshake fires.
    lastChild._handlers.exit?.(1);
    // The exit handler synchronously kicks respawn → fork → new lastChild.
    lastChild._handlers.message?.({ id: 0, result: 'ready' });
    // Drain microtasks (readyPromise.then in respawn).
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onRespawn fires ONLY on respawn (not on initial start)', async () => {
    const sup = new PtyHostSupervisor();
    const cb = vi.fn();
    sup.onRespawn(cb);

    const p = sup.start();
    lastChild._handlers.message?.({ id: 0, result: 'ready' });
    await p;
    expect(cb).not.toHaveBeenCalled();

    // Crash → respawn → second ready: callback fires.
    lastChild._handlers.exit?.(1);
    lastChild._handlers.message?.({ id: 0, result: 'ready' });
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing onReady callback does not break subsequent callbacks', async () => {
    const sup = new PtyHostSupervisor();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    sup.onReady(bad);
    sup.onReady(good);

    const p = sup.start();
    lastChild._handlers.message?.({ id: 0, result: 'ready' });
    await p;

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      '[pty-host] onReady cb threw',
      expect.any(Error)
    );
  });
});
