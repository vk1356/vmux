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
