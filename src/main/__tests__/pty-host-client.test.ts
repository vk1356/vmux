import { describe, it, expect, vi } from 'vitest';
import { PtyHostClient } from '../pty-host-client';

// Fake supervisor: captures sent requests, lets the test push events/replies
// and fire the (re)spawn ready handshake.
function makeFakeSupervisor() {
  let onMsg: ((m: unknown) => void) | null = null;
  let onReady: (() => void) | null = null;
  const sent: unknown[] = [];
  return {
    sup: {
      start: vi.fn().mockResolvedValue(undefined),
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (m: unknown) => void) => { onMsg = cb; },
      onReady: (cb: () => void) => { onReady = cb; },
      stop: vi.fn().mockResolvedValue(undefined)
    },
    sent,
    push: (m: unknown) => onMsg?.(m),
    ready: () => onReady?.()
  };
}

describe('PtyHostClient', () => {
  it('forwards paneData through the main EventEmitter (ipc.ts → webContents.send)', () => {
    // PTY bytes flow via parentPort structured-clone. ipc.ts subscribes to
    // ptyManager.on('paneData', ...) and forwards to the renderer per window
    // (Phase-2 MessagePort transport is wired but dormant — see entry.ts).
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const seen: Array<[string, Uint8Array]> = [];
    client.on('paneData', (paneId, data) => seen.push([paneId, data]));
    push({ kind: 'paneData', paneId: 'p1', data: new Uint8Array([65]) });
    expect(seen).toEqual([['p1', new Uint8Array([65])]]);
  });

  it('proxies a method call as a HostRequest and resolves on reply', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const p = client.removeSession('s1');
    expect(sent[0]).toMatchObject({ method: 'removeSession', args: ['s1'] });
    const reqId = (sent[0] as { id: number }).id;
    push({ id: reqId, result: undefined });
    await expect(p).resolves.toBeUndefined();
  });

  it('list() returns the cached snapshot synchronously, updated on sessionUpdate', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    expect(client.list()).toEqual([]);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: {}, tree: { kind: 'leaf', paneId: 'p' }, cwd: '/', createdAt: 0, activePaneId: 'p' } });
    expect(client.list().map((s) => s.id)).toEqual(['s1']);
  });

  it('sessionForPane resolves from the cached snapshot synchronously', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: { p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 } }, tree: { kind: 'leaf', paneId: 'p1' }, cwd: '/', createdAt: 0, activePaneId: 'p1' } });
    expect(client.sessionForPane('p1')).toBe('s1');
  });

  it('cacheSession drops panes removed intra-session from the pane index (incremental)', () => {
    const { sup, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const twoPanes = {
      id: 's1', name: 'x',
      panes: {
        p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 },
        p2: { id: 'p2', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 }
      },
      tree: { kind: 'leaf', paneId: 'p1' }, cwd: '/', createdAt: 0, activePaneId: 'p1'
    };
    push({ kind: 'sessionUpdate', session: twoPanes });
    expect(client.sessionForPane('p1')).toBe('s1');
    expect(client.sessionForPane('p2')).toBe('s1');
    // p2 closed intra-session → next sessionUpdate omits it; index must drop it.
    push({ kind: 'sessionUpdate', session: { ...twoPanes, panes: { p1: twoPanes.panes.p1 } } });
    expect(client.sessionForPane('p1')).toBe('s1');
    expect(client.sessionForPane('p2')).toBeUndefined();
  });

  it('removeSession prunes the snapshot + pane index after the reply resolves', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: { p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 } }, tree: { kind: 'leaf', paneId: 'p1' }, cwd: '/', createdAt: 0, activePaneId: 'p1' } });
    expect(client.list().map((s) => s.id)).toEqual(['s1']);
    expect(client.sessionForPane('p1')).toBe('s1');
    const p = client.removeSession('s1');
    const reqId = (sent[0] as { id: number }).id;
    push({ id: reqId, result: undefined });
    await p;
    expect(client.list()).toEqual([]);
    expect(client.sessionForPane('p1')).toBeUndefined();
  });

  it('closePane returning null prunes the whole session', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    push({ kind: 'sessionUpdate', session: { id: 's1', name: 'x', panes: { p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 } }, tree: { kind: 'leaf', paneId: 'p1' }, cwd: '/', createdAt: 0, activePaneId: 'p1' } });
    const p = client.closePane('s1', 'p1');
    const reqId = (sent[0] as { id: number }).id;
    push({ id: reqId, result: null });
    await p;
    expect(client.list()).toEqual([]);
    expect(client.sessionForPane('p1')).toBeUndefined();
  });

  it('closePane returning a Session does NOT prune', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const s1 = {
      id: 's1', name: 'x',
      panes: {
        p1: { id: 'p1', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 },
        p2: { id: 'p2', kind: 'terminal', agentId: 'shell', status: 'running', cwd: '/', createdAt: 0 }
      },
      tree: { kind: 'leaf', paneId: 'p2' }, cwd: '/', createdAt: 0, activePaneId: 'p2'
    };
    push({ kind: 'sessionUpdate', session: s1 });
    const p = client.closePane('s1', 'p1');
    const reqId = (sent[0] as { id: number }).id;
    const remaining = { ...s1, panes: { p2: s1.panes.p2 } };
    push({ id: reqId, result: remaining });
    await p;
    expect(client.list().map((s) => s.id)).toEqual(['s1']);
  });

  it('rejects on a reply with an empty-string error', async () => {
    const { sup, sent, push } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    const p = client.removeSession('x');
    const reqId = (sent[0] as { id: number }).id;
    push({ id: reqId, error: '' });
    await expect(p).rejects.toThrow();
  });

  it('rejects in-flight RPCs when the host (re)spawns instead of hanging forever', async () => {
    const { sup, ready } = makeFakeSupervisor();
    const client = new PtyHostClient(sup as never);
    // A call awaiting a reply that will never come (the old child died).
    const p = client.createSession({ name: 'x', agentId: 'shell', cwd: '/' });
    const assertion = expect(p).rejects.toThrow('pty host restarted');
    // New host handshakes → onReady fires → pending must reject.
    ready();
    await assertion;
  });

  it('respawn ready handshake is a no-op when no RPC is in flight', () => {
    const { sup, ready } = makeFakeSupervisor();
    new PtyHostClient(sup as never);
    // Should not throw / nothing pending to reject.
    expect(() => ready()).not.toThrow();
  });
});
